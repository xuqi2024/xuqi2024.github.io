/* global mermaid */
// Hermes 修复 Next 主题 mermaid.js 兼容性补丁
// 背景: hexo-renderer-marked 把 ```mermaid 渲染成 <pre><code class="language-mermaid">
//      Next 主题 8.23 的 mermaid.js 只找 'pre > .mermaid' 或 'div.mermaid'
//      这个脚本把 language-mermaid 代码块在客户端转成 div.mermaid

document.addEventListener('page:loaded', () => {
  // 找所有 <pre><code class="language-mermaid"> ... </code></pre>
  const mermaidCodes = document.querySelectorAll('pre > code.language-mermaid');
  if (!mermaidCodes.length) return;

  // 每个都包一层 div.mermaid
  const newDivs = [];
  mermaidCodes.forEach((code) => {
    const pre = code.parentNode;
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid';
    // 把 mermaid 源码作为文本节点放进去
    wrapper.textContent = code.textContent;
    // 替换原 pre
    pre.parentNode.replaceChild(wrapper, pre);
    newDivs.push(wrapper);
  });

  // 加载 mermaid.js 并渲染
  if (!window.mermaid) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.5.0/dist/mermaid.min.js';
    script.onload = () => {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        logLevel: 4,
        flowchart: { curve: 'linear' },
        sequence: { actorMargin: 50 },
      });
      window.mermaid.run();
    };
    document.head.appendChild(script);
  } else {
    window.mermaid.run();
  }
});