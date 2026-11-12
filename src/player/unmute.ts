/* 取消静音后的播放恢复（Android WebView「开声音画面冻结」修复）。
 *
 * 现象（录屏实测）：静音自动播放中点开声音后，声音正常出来，但画面帧
 * 冻住约 2 秒，元素并未 paused、播放时间仍在走；关回静音画面立刻恢复。
 * 旧路径的问题：点按钮只改 React state，再由异步 effect 去设 video.muted，
 * 脱离了用户手势的同步调用链 — WebView/Chromium 对「脚本取消静音」可以
 * 介入暂停，且静音→有声会切换音视频同步时钟，MSE 的帧呈现会卡住，
 * 两边都不会自己恢复。
 *
 * 这里做三件事（都只在「真从静音切到有声、且原本在播」时触发）：
 * 1. 由调用方在本模块之外、仍处于手势同步链时先把 video.muted 设好；
 * 2. 短时后若元素被策略暂停，补一次 play() 把播放重申回来；
 * 3. requestVideoFrameCallback 看门狗：约 700ms 内呈现的新帧不足 5 帧，
 *    但元素状态正常（未暂停/未结束/有数据/页面可见），判定帧冻结，
 *    用一次「原地重锚」resync（hls 从当前点重新加载并重设 currentTime）
 *    把帧呈现管线踢活；只做一次，不循环、不跳进度。
 * 返回 cleanup：再次静音/切源/卸载时调用，撤销未触发的看门狗。
 */

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function onUnmute(video: HTMLVideoElement, resync: (t: number) => void): () => void {
  let cancelled = false;
  const timers: number[] = [];
  let rvfcHandle = 0;
  const v = video as FrameCallbackVideo;

  // 策略暂停兜底：给浏览器介入留一个短窗口，被暂停就重申播放。
  timers.push(window.setTimeout(() => {
    if (cancelled || video.muted || video.ended) return;
    if (video.paused) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    }
  }, 250));

  // 帧冻结看门狗：requestVideoFrameCallback 是一次性的，循环登记数帧；
  // 700ms 内呈现的新帧少于 5 帧（正常播放应为十几帧）判定为帧冻结。
  let frames = 0;
  if (typeof v.requestVideoFrameCallback === "function") {
    const loop = () => {
      if (cancelled) return;
      rvfcHandle = v.requestVideoFrameCallback(() => { frames += 1; loop(); });
    };
    loop();
    timers.push(window.setTimeout(() => {
      if (cancelled || frames >= 5 || video.muted || video.paused || video.ended) return;
      // 缓冲/定位中本就不出帧，不算冻结：要求已有后续数据（HAVE_FUTURE_DATA）
      if (document.visibilityState !== "visible" || video.readyState < 3 || video.seeking) return;
      resync(video.currentTime);
    }, 700));
  } else {
    // 无 requestVideoFrameCallback 时退化为时间停滞检测（全卡死型冻结）。
    const t0 = video.currentTime;
    timers.push(window.setTimeout(() => {
      if (cancelled || video.muted || video.paused || video.ended) return;
      if (video.readyState < 3 || video.seeking) return;
      if (video.currentTime <= t0 + 0.05) resync(video.currentTime);
    }, 700));
  }

  return () => {
    cancelled = true;
    timers.forEach((t) => window.clearTimeout(t));
    if (rvfcHandle && typeof v.cancelVideoFrameCallback === "function") {
      try { v.cancelVideoFrameCallback(rvfcHandle); } catch { /* 已触发 */ }
    }
  };
}
