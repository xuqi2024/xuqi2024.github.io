hexo.extend.filter.register('after_post_render', function(data) {
  if (data.layout === 'post' || data.layout === 'page') {
    if (data.content && data.content.includes('mermaid')) {
      data.content = data.content.replace(
        '</head>',
        '<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script></head>'
      );
    }
  }
  return data;
});
