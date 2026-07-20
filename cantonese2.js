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
const inputText = `神經病，無憑無據`;

// console.log(annotateCantoneseToRuby(inputText));
console.log(getJyutpingList(inputText))
