import {test, chromium} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const cases=[['chromium','default'],['chrome','default'],['msedge','default'],['chrome','high-performance'],['msedge','high-performance']];
for(const [channel,powerPreference] of cases)test(channel+'-'+powerPreference,async()=>{
 const browser=await chromium.launch({channel,headless:true});
 try{
  const page=await browser.newPage();
  await page.goto(pathToFileURL(path.resolve('reports/browser-gpu-audit/adapter.html')).href);
  const result=await page.evaluate(async preference=>{
   const state:any={secureContext:isSecureContext,gpu:Boolean(navigator.gpu),webnn:Boolean((navigator as any).ml),adapters:[]};
   if(navigator.gpu){
    const adapter=await navigator.gpu.requestAdapter(preference==='default'?{}:{powerPreference:preference as GPUPowerPreference});
    state.available=Boolean(adapter);
    if(adapter){const i=adapter.info;state.info={vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description,isFallbackAdapter:(i as any).isFallbackAdapter};const d=await adapter.requestDevice();state.deviceCreated=true;d.destroy();}
   }
   return state;
  },powerPreference);
  const observation={channel,version:browser.version(),powerPreference,...result};
  await fs.mkdir('.tmp/gpu-audit/adapter-results',{recursive:true});
  await fs.writeFile(`.tmp/gpu-audit/adapter-results/${channel}-${powerPreference}.json`,JSON.stringify(observation,null,2));
  console.log(JSON.stringify(observation));
 }finally{await browser.close();}
});
