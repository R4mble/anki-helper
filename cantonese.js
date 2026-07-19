const Cantonese = require('cantonese-romanisation');

// 权威粤语字库数据硬编码兜底（专门狙击多音高频漏字）
const HARD_FALLBACK_DICT = {
    '当': 'dong1',
    '过': 'gwo3',
    '时': 'si4',
    '到': 'dou3',
    '着': 'zoek6',
    '被': 'bei6',
    '把': 'baa2',
    '给': 'kap1',
    '还': 'waan4',
    '有': 'jau5',
    '没': 'mut6'
};

/**
 * 给输入的粤语文本标注拼音（三级防御体系：整行分析 -> 单字解析 -> 核心字典硬兜底）
 */
function annotateCantoneseToRuby(text) {
    let outputHtml = `<div style="text-align: center; line-height: 3; font-family: sans-serif; font-size: 18px;">\n`;
    const lines = text.split('\n');
    
    lines.forEach(line => {
        if (!line.trim()) {
            outputHtml += `<br>\n`;
            return;
        }

        // 1. 第一道防线：整行进行词法解析
        const resultMatrix = Cantonese.getLshk(line);

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            let pronunciations = resultMatrix[i];
            let finalJyutping = '';

            if (/[\u4e00-\u9fa5]/.test(char)) {
                // 2. 第二道防线：如果整行漏掉，尝试单字解析
                if (!pronunciations || pronunciations.length === 0) {
                    const singleRes = Cantonese.getLshk(char);
                    if (singleRes && singleRes[0] && singleRes[0].length > 0) {
                        finalJyutping = singleRes[0][0];
                    }
                } else {
                    finalJyutping = pronunciations[0];
                }

                // 3. 第三道防线：终极硬编码字典兜底
                if (!finalJyutping && HARD_FALLBACK_DICT[char]) {
                    finalJyutping = HARD_FALLBACK_DICT[char];
                }
            }

            // 渲染输出
            if (finalJyutping) {
                outputHtml += `<ruby style="ruby-position: over; ruby-align: center; margin: 0 4px;">${char}<rt style="font-size: 12px; color: #666;">${finalJyutping}</rt></ruby>`;
            } else if (char === ' ') {
                outputHtml += '&nbsp;&nbsp;';
            } else if (/[\u4e00-\u9fa5]/.test(char)) {
                // 如果极其罕见的字连兜底都没有，依然保留字并给个空 rt 占位，防止排版错位
                outputHtml += `<ruby style="ruby-position: over; ruby-align: center; margin: 0 4px;">${char}<rt style="font-size: 12px; color: #666;">&nbsp;</rt></ruby>`;
            } else {
                outputHtml += `<span style="margin: 0 4px;">${char}</span>`;
            }
        }
        
        outputHtml += `<br>\n`;
    });

    outputHtml += `</div>`;
    return outputHtml;
}

// === 测试运行 ===
const inputText = `朋友 我当你一秒朋友
朋友 我当你一世朋友
奇怪 过去再不堪回首
怀缅 时时其实还有
朋友 你试过将我营救
朋友 你试过把我批斗
无法 再与你交心联手
毕竟 难得 有过最佳损友
从前共你 促膝把酒 倾通宵都不够
我有痛快过 你有没有
很多东西今生只可给你 保守至到永久
别人如何明白透
实实在在 踏入过我宇宙
即使相处到有个裂口
命运决定了 以后再没法聚头
但说过去却那样厚
问我有没有 确实也没有
一直躲避的藉口 非什么大仇
为何旧知己 在最后 变不到老友
不知你是我敌友 已没法望透
被推着走 跟着生活流
来年陌生的 是昨日最亲的某某
生死之交 当天不知罕有
到你变节了 至觉未够
多想一天 彼此都不追究 相邀再次喝酒
待葡萄成熟透
但是命运入面每个邂逅
一起走到了某个路口
是敌与是友 各自也没有自由
位置变了各有队友
问我有没有 确实也没有
一直躲避的藉口 非什么大仇
为何旧知己 在最后 变不到老友
不知你是我敌友 已没法望透
被推着走 跟着生活流
来年陌生的 是昨日最亲的某某
早知解散后 各自有际遇作导游
奇就奇在 接受了 各自有路走
却没人像你 让我 眼泪背着流
严重似情侣 讲分手
有没有 确实也没有
一直躲避的藉口 非什么大仇
为何旧知己 在最后 变不到老友
不知你又有没有 挂念这旧友
或者自己 早就想通透
来年陌生的 是昨日最亲的某某
总好于 那日我 没有
没有 遇过 某某`;

console.log(annotateCantoneseToRuby(inputText));