/* global mermaid */
// Hermes 终极 Mermaid 渲染修复补丁
// 背景:
//   1. hexo-renderer-marked + highlight.js 把 ```mermaid 渲染成
//      <pre><code class="highlight mermaid">flowchart LR...</code></pre>
//   2. Next 主题 8.23 的 mermaid.js 在 'page:loaded' 事件里扫描 'pre > .mermaid'
//      应当能匹配,但实际不渲染(SVG 数=0)
//   3. 我写的 div.mermaid 被 DOMPurify 完全清洗掉了
//
// 解法:
//   主动扫描所有含 mermaid class 的元素,主动 load mermaid.js,主动 mermaid.run()
//   不依赖 page:loaded,直接 DOMContentLoaded 就跑

(function () {
  'use strict';

  function findMermaidElements() {
    // 所有可能的 mermaid 容器
    const candidates = document.querySelectorAll(
      'pre > code.mermaid, ' +
      'pre > code.language-mermaid, ' +
      'pre.mermaid, ' +
      'div.mermaid, ' +
      'code.mermaid'
    );
    // 去重
    const seen = new Set();
    const result = [];
    candidates.forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      // 提取源码:如果是 code 取 textContent,如果是 pre/div 取 innerText
      const source = el.textContent.trim();
      if (!source) return;
      // 基本判断:是否含 mermaid 关键字
      if (!/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context)\b/.test(source)) return;
      result.push({el, source});
    });
    return result;
  }

  function renderAll() {
    const items = findMermaidElements();
    if (items.length === 0) return;

    // 把每个元素替换为 div.mermaid 容器
    items.forEach(({el, source}) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid';
      wrapper.textContent = source;
      el.parentNode.replaceChild(wrapper, el);
    });

    // 加载 mermaid 库
    const renderNow = () => {
      if (!window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: { curve: 'linear' },
        sequence: { actorMargin: 50 },
      });
      window.mermaid.run();
    };

    if (!window.mermaid) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.5.0/dist/mermaid.min.js';
      script.onload = renderNow;
      document.head.appendChild(script);
    } else {
      renderNow();
    }
  }

  // 多触发点都跑一次,确保 Pjax/初始加载都覆盖
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll);
  } else {
    renderAll();
  }
  document.addEventListener('page:loaded', renderAll);
  // 兜底:1.5 秒后再跑一次
  setTimeout(renderAll, 1500);
  // 兜底:3 秒后再跑一次
  setTimeout(renderAll, 3000);
})();