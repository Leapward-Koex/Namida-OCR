import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '../../tests/extension.fixtures';

const scenarios = ['gpu-enabled', 'gpu-disabled', 'gpu-api-unavailable', 'adapter-unavailable', 'gpu-device-lost'];
for (const scenario of scenarios) {
 test(scenario, async ({ context, page, serviceWorker, extensionId }, testInfo) => {
  // Instrument this test's extension copy before its offscreen document starts.
  const file = testInfo.outputPath('extension-under-test', 'offscreen', 'index.js');
  const original = await fs.readFile(file,'utf8');
  await fs.writeFile(file, `(${installAuditHooks.toString()})(${JSON.stringify(scenario)});\n${original}`);
  await serviceWorker.evaluate(async gpu => {
   await chrome.storage.sync.clear();
   await chrome.storage.sync.set({ OcrBackend:'paddleonnx', PaddleOnnxGpuEnabled:gpu, OcrDebugArtifacts:true, FuriganaType:'none' });
  }, scenario !== 'gpu-disabled');
  await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  const image = 'data:image/png;base64,' + (await fs.readFile('tests/fixtures/images/ocr-general-002.png')).toString('base64');
  const observations:any = { scenario, browser:context.browser()?.version(), requests:[] };
  for (let index=0;index<2;index++) {
   if(index===1 && scenario==='gpu-device-lost') {
    observations.destroyed = await page.evaluate(()=>chrome.runtime.sendMessage({action:9902}));
   }
   const start=Date.now();
   observations.requests.push(await page.evaluate(async data=> {
    try { return { text:await chrome.runtime.sendMessage({action:3,data}) }; }
    catch(error) { return {error:String(error)}; }
   },image));
   observations.requests[index].elapsedMs=Date.now()-start;
   observations.requests[index].diagnostics=await page.evaluate(()=>chrome.runtime.sendMessage({action:9901}));
  }
  const destination = path.resolve('.tmp/gpu-audit/results');
  await fs.mkdir(destination,{recursive:true});
  await fs.writeFile(path.join(destination,scenario+'.json'),JSON.stringify(observations,null,2));
  expect(observations.requests[0].diagnostics?.installed).toBe(true);
  console.log(JSON.stringify({scenario, requests:observations.requests.map((r:any)=>({text:r.text,error:r.error,elapsedMs:r.elapsedMs,adapters:r.diagnostics?.adapters,submits:r.diagnostics?.submits,dispatches:r.diagnostics?.dispatches,lost:r.diagnostics?.lost}))}));
 });
}

function installAuditHooks(scenario:string) {
 const state:any={installed:true,scenario,gpuApi:Boolean(navigator.gpu),mlApi:Boolean((navigator as any).ml),adapters:[],deviceCount:0,submits:0,dispatches:0,pipelines:0,lost:[],logs:[],hookErrors:[]};
 const devices:any[]=[];
 const stringify=(arg:any)=>arg instanceof Error?{message:arg.message,stack:arg.stack}:arg;
 for(const level of ['info','warn','error'] as const) {
  const original=console[level].bind(console);
  console[level]=(...args:any[])=>{
   if(state.logs.length<200) {try{state.logs.push({level,args:JSON.parse(JSON.stringify(args.map(stringify)))});}catch{}}
   original(...args);
  };
 }
 if(scenario==='gpu-api-unavailable') {
  Object.defineProperty(navigator,'gpu',{value:undefined});
  Object.defineProperty(navigator,'ml',{value:undefined});
 } else if(navigator.gpu) {
  const requestAdapter=navigator.gpu.requestAdapter.bind(navigator.gpu);
  Object.defineProperty(navigator.gpu,'requestAdapter',{value:async(options:any)=>{
   const adapter=scenario==='adapter-unavailable'?null:await requestAdapter(options);
   const info=adapter?.info;
   state.adapters.push({options:options??null,available:Boolean(adapter),info:info?{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:(info as any).isFallbackAdapter??(adapter as any).isFallbackAdapter}:null});
   if(adapter){
    const requestDevice=adapter.requestDevice.bind(adapter);
    Object.defineProperty(adapter,'requestDevice',{value:async(descriptor:any)=>{
     const device=await requestDevice(descriptor);devices.push(device);state.deviceCount++;
     device.lost.then(reason=>state.lost.push({reason:reason.reason,message:reason.message}));
     const submit=device.queue.submit.bind(device.queue);
     Object.defineProperty(device.queue,'submit',{value:(commands:any)=>{state.submits++;return submit(commands);}});
     for(const key of ['createComputePipeline','createComputePipelineAsync']) {
      const method=(device as any)[key].bind(device);
      Object.defineProperty(device,key,{value:(descriptor:any)=>{state.pipelines++;return method(descriptor);}});
     }
     return device;
    }});
   }
   return adapter;
  }});
  if(typeof GPUComputePassEncoder!=='undefined') {
   for(const key of ['dispatchWorkgroups','dispatchWorkgroupsIndirect']) {
    const original=(GPUComputePassEncoder.prototype as any)[key];
    (GPUComputePassEncoder.prototype as any)[key]=function(...args:any[]){state.dispatches++;return original.apply(this,args);};
   }
  }
 }
 chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
  if(message.action===9901)respond(state);
  if(message.action===9902){for(const device of devices)device.destroy();respond({destroyed:devices.length});}
 });
}
