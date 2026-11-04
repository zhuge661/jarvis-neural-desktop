/* Two local replies. Neither needs a model or online speech synthesis. */
(function () {
  "use strict";
  const replies = Object.freeze({
    wake: Object.freeze({ text: "我已准备就绪，随时能为您服务", audio: "audio/builtin/wake.mp3" }),
    "configure-api": Object.freeze({ text: "请先配置模型api", audio: "audio/builtin/configure-api.mp3" }),
  });
  function isWake(text) {
    const words = String(text).replace(/[\s\p{P}]/gu, "");
    return /^(?:你好|您好|嗨|嘿|喂)?(?:贾维斯|jarvis)(?:你好|您好|在吗|你在吗|在不在|启动|唤醒)?$/i.test(words);
  }
  window.BuiltinReplies = Object.freeze({ replies, isWake });
})();
