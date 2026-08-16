// 自绘标题栏注入（独立文件注入：无模板字符串转义陷阱，可正常使用正则/模板）
// 由 main.js 在 did-finish-load 后 executeJavaScript 注入页面主世界
(() => {
  if (document.getElementById('dsh-titlebar')) return;
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (d) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.2');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  };
  const tb = document.createElement('div');
  tb.id = 'dsh-titlebar';
  const title = document.createElement('div');
  title.className = 'dsh-tb-title';
  title.innerHTML =
    '<span class="dsh-tb-seg" data-part="title"></span>' +
    '<span class="dsh-tb-sep" data-part="sep1">·</span>' +
    '<span class="dsh-tb-seg" data-part="mode" style="max-width:180px"></span>' +
    '<span class="dsh-tb-sep" data-part="sep2">·</span>' +
    '<span class="dsh-tb-seg" data-part="model" style="max-width:200px"></span>';
  const ctrl = document.createElement('div');
  ctrl.className = 'dsh-tb-controls';
  const mk = (act, d, tip) => {
    const b = document.createElement('button');
    b.className = 'dsh-tb-btn';
    b.title = tip;
    b.appendChild(icon(d));
    b.dataset.act = act;
    ctrl.appendChild(b);
    return b;
  };
  const btnMin = mk('min', 'M2 8h12', '最小化');
  const btnMax = mk('max', 'M3 3h10v10H3z', '最大化');
  const btnClose = mk('close', 'M4 4l8 8M12 4l-8 8', '关闭');
  tb.appendChild(title);
  tb.appendChild(ctrl);
  document.body.appendChild(tb);
  // 初始背景：直接读取 body 背景色（preload 观察器随后负责实时更新）
  const tbBg = getComputedStyle(document.body).backgroundColor;
  if (tbBg) tb.style.background = tbBg;
  btnMin.addEventListener('click', () => window.dshDesktop && window.dshDesktop.windowControls.minimize());
  btnMax.addEventListener('click', async () => {
    if (window.dshDesktop) {
      const m = await window.dshDesktop.windowControls.toggleMaximize();
      window.dispatchEvent(new CustomEvent('dsh-max-changed', { detail: { maximized: m } }));
    }
  });
  btnClose.addEventListener('click', () => window.dshDesktop && window.dshDesktop.windowControls.close());
})();
