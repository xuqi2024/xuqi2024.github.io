hexo.extend.filter.register("after_render:html", function(html, data) {
  var mermaidScript = "<script src=\\"https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js\\"></script>";
  if (html && html.includes("mermaid")) {
    html = html.replace("</head>", mermaidScript + "</head>");
  }
  return html;
});