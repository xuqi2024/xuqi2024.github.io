// Convert fenced code blocks rendered as `class="language-mermaid"` (by hexo-renderer-marked)
// into `class="mermaid"` so that NexT theme's built-in mermaid JS can detect and render them.
hexo.extend.filter.register('after_render:html', function(html) {
  if (html && html.includes('language-mermaid')) {
    html = html.replace(/<code([^>]*?)class="([^"]*?\s)?language-mermaid(\s[^"]*?)?"([^>]*?>)/g, function(match, before, pre, post, after) {
      var cls = ((pre || '') + 'mermaid' + (post || '')).trim();
      return '<code' + before + 'class="' + cls + '"' + after;
    });
  }
  return html;
});
