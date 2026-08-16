// 页面适配器（独立文件注入：无模板字符串转义陷阱，正则可正常书写）
// 职责：1) 右侧面板下移/去线/背景统一 2) 设置弹窗全窗居中（打开时面板让路）
// 性能：MutationObserver 只对"疑似面板相关"的 DOM 变化触发全扫，聊天流式输出不触发
(() => {
  const H = __TB_H__;

  function adapters() {
    const bgRaw = String(getComputedStyle(document.body).backgroundColor || '');
    const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(bgRaw);
    const solid = m ? 'rgb(' + m[1] + ', ' + m[2] + ', ' + m[3] + ')' : '';
    let rightW = 0;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.width > 900 || r.height < 200 || r.bottom > window.innerHeight + 10) continue;
      const cls = String(el.className);
      if (/overlay|Overlay|mask|Mask/.test(cls)) continue; // 跳过遮罩层
      const isRightEdge = r.right >= window.innerWidth - 10;
      const isTopEdge = r.top <= 10;
      if (isRightEdge) {
        rightW = r.width;
        el.style.borderLeft = 'none';
        el.style.boxShadow = 'none';
        if (solid) el.style.background = solid;
      }
      if (isTopEdge) {
        const curTop = parseFloat(cs.top) || 0;
        if (curTop < H - 2) {
          el.style.top = (curTop + H) + 'px';
          el.style.height = (r.height - H) + 'px';
        }
        if (el.dataset) el.dataset.dshTbFixed = '1';
      }
    }
    // 设置弹窗：打开时面板让路 + 全窗居中（CSS 变量控制，!important 防 React 覆盖）
    // 先切换 html 类（classList 变更后同帧 getComputedStyle 即生效：被隐藏的面板 rightW 归零），
    // 再测量右面板宽度：若仍有可见右面板（类名漂移等 fallback），弹窗向右平移 rightW/2 实现真居中。
    const sp = document.querySelector('[class*=VOzbGW_panel]');
    if (sp) document.documentElement.classList.add('dsh-settings-open');
    else document.documentElement.classList.remove('dsh-settings-open');
    let visibleRightW = 0;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.width > 900 || r.height < 200 || r.bottom > window.innerHeight + 10) continue;
      if (/overlay|Overlay|mask|Mask/.test(String(el.className))) continue;
      if (r.right >= window.innerWidth - 10) visibleRightW = r.width;
    }
    document.documentElement.style.setProperty('--dsh-main-w', window.innerWidth + 'px');
    document.documentElement.style.setProperty('--dsh-main-offset', (visibleRightW > 0 ? visibleRightW / 2 : 0) + 'px');
  }

  let rafPending = false;
  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; adapters(); });
  }

  // 只对"疑似面板/设置弹窗相关"变化全扫；聊天消息等普通节点变化直接跳过
  function isRelevantMutation(muts) {
    for (const mu of muts) {
      if (mu.type === 'attributes') return true; // class/style 变化（面板 Hidden 切换、主题）低频
      if (mu.type === 'childList') {
        // addedNodes：面板/弹窗出现；removedNodes：关闭（否则 dsh-settings-open 类会残留，右侧面板一直隐藏）
        for (const list of [mu.addedNodes, mu.removedNodes]) {
          for (const n of list) {
            if (n.nodeType === 1 && /_panel|VOzbGW|us-shell|_overlay|_footer|_rail/.test(String(n.className || ''))) return true;
          }
        }
      }
    }
    return false;
  }

  adapters();
  [500, 2000, 5000, 12000].forEach(function (ms) { setTimeout(schedule, ms); });
  try {
    new MutationObserver(function (muts) { if (isRelevantMutation(muts)) schedule(); })
      .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  } catch {}
  window.addEventListener('resize', schedule);
})();