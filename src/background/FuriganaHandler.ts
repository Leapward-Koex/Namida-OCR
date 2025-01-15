

import * as kuromoji from '@leapward-koex/kuromoji';
import { NamidaMessageAction } from '../interfaces/message';
import { runtime } from 'webextension-polyfill';
import { Settings } from '../interfaces/Storage';

export enum FuriganaType {
    None,
    Hiragana,
    Katakana,
}

export class FuriganaHandler {
    private static logTag = `[${FuriganaHandler.name}]`;
    private static tokenizerBuilderPromise: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | undefined;

    constructor() {
    }

    private static async initializeTokenizer() {
        if (!this.tokenizerBuilderPromise) {
            this.tokenizerBuilderPromise = new Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>>((resolve, reject) => {
                try {
                    const builder = kuromoji.builder({
                        dicPath: "../libs/kuromoji", fileNameOptions: {
                            base: "base.dat.zg",
                            check: "check.dat.zg",
                            tid: "tid.dat.zg",
                            tidPos: "tid_pos.dat.zg",
                            tidMap: "tid_map.dat.zg",
                            cc: "cc.dat.zg",
                            unk: "unk.dat.zg",
                            unkPos: "unk_pos.dat.zg",
                            unkMap: "unk_map.dat.zg",
                            unkChar: "unk_char.dat.zg",
                            unkCompat: "unk_compat.dat.zg",
                            unkInvoke: "unk_invoke.dat.zg"
                        }
                    });
                    builder.build((err, tokenizer) => {
                        if (err) {
                            this.tokenizerBuilderPromise = undefined;
                            console.error(this.logTag, "Failed to create furigana builder", err);
                            reject(err);
                            return;
                        }
                        resolve(tokenizer);
                    });
                }
                catch (err) {
                    console.error(this.logTag, "Failed to create furigana builder", err);
                    this.tokenizerBuilderPromise = undefined;
                }
            })
        }
        return this.tokenizerBuilderPromise;
    }

    public static async generateFurigana(data: string) {
        console.debug(this.logTag, "Getting furigana tokenizer");
        var tokenizer = await this.initializeTokenizer();
        console.debug(this.logTag, "Created furigana tokenizer");
        var tokenized = tokenizer.tokenize(data);
        console.debug(this.logTag, "Tonikenized input", tokenized);
        return tokenized;
    }

    public static async generateFuriganaFromContent(input: String) {
        const output = await runtime.sendMessage({
            action: NamidaMessageAction.GenerateFurigana, data: input
        }) as kuromoji.IpadicFeatures[];
        console.log(this.logTag, `Generated furigana: ${output} from ${input}`)
        const furiganaType = await Settings.getFuriganaType();
        return FuriganaHandler.convertToHtml(output, furiganaType);
    }

    public static toKatakana(hiragana: string) {
        return hiragana.replace(/[\u3041-\u3096]/g, ch =>
            String.fromCharCode(ch.charCodeAt(0) + 0x60)
        );
    }

    public static toHiragana(katakana: string): string {
        return katakana.replace(/[\u30A1-\u30F6]/g, ch =>
            String.fromCharCode(ch.charCodeAt(0) - 0x60)
        );
    }

    public static isAllKana(str: string) {
        return /^[\u3040-\u309F\u30A0-\u30FF]+$/.test(str);
    }

    public static convertToHtml(data: kuromoji.IpadicFeatures[], furiganaType: FuriganaType) {
        let html = "";

        for (const token of data) {
            if (token.surface_form === "\n") {
                html += "<br>";
                continue;
            }

            if (!token.reading || token.reading === "*" || furiganaType == FuriganaType.None) {
                html += token.surface_form;
                continue;
            }

            if (FuriganaHandler.isAllKana(token.surface_form)) {
                const katakanaForm = FuriganaHandler.toKatakana(token.surface_form);

                if (katakanaForm === token.reading) {
                    html += token.surface_form; // no furigana
                    continue;
                }
            }

            let tokenReading = token.reading;
            if (furiganaType == FuriganaType.Hiragana) {
                tokenReading = this.toHiragana(tokenReading);
            }

            html += `<ruby>${token.surface_form}<rt>${tokenReading}</rt></ruby>`;
        }

        return html;
    }
}
