const { getJyutpingList } = require('to-jyutping');

/**
 * 基于 to-jyutping 的 getJyutpingList API 实现完美居中对齐注音
 * @param {string} text - 输入的粤语文本
 * @returns {string} - HTML 格式的完美居中对齐文本
 */
function annotateCantoneseToRuby(text) {
    let outputHtml = `<div style="text-align: center; line-height: 3; font-family: sans-serif; font-size: 18px;">\n`;
    const lines = text.split('\n');

    lines.forEach(line => {
        if (!line.trim()) {
            outputHtml += `<br>\n`;
            return;
        }

        // 调用正确的 API，返回示例：[['朋友', 'pang4 jau5'], [' ', null]]
        const list = getJyutpingList(line);

        list.forEach(([rawWord, jyutpingStr]) => {
            // 情况 1：匹配到汉字且有对应的拼音
            if (jyutpingStr && /[\u4e00-\u9fa5]/.test(rawWord)) {
                // 拼音字符串按空格切分成单字拼音数组，例如 ['pang4', 'jau5']
                const jpArray = jyutpingStr.split(' ');
                
                // 逐字渲染，确保字音一对一居中对齐
                for (let i = 0; i < rawWord.length; i++) {
                    const char = rawWord[i];
                    const pinyin = jpArray[i] || ''; // 防止数组越界兜底
                    outputHtml += `<ruby style="ruby-position: over; ruby-align: center; margin: 0 4px;">${char}<rt style="font-size: 12px; color: #666;">${pinyin}</rt></ruby>`;
                }
            } 
            // 情况 2：纯空格处理
            else if (rawWord.trim() === '') {
                // 将空格转换，长度跟原空格匹配
                outputHtml += '&nbsp;'.repeat(rawWord.length * 2);
            } 
            // 情况 3：标点符号或其他非汉字字符
            else {
                for (let char of rawWord) {
                    outputHtml += `<span style="margin: 0 4px;">${char}</span>`;
                }
            }
        });

        // 换行
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