/**
 * Hexo script: inject Tomorrow Night Eighties highlight.js theme
 *
 * highlight.js v11 dropped the "tomorrow-night-eighties" style.
 * This script writes it back to node_modules/highlight.js/styles/
 * before Hexo generates the site, so it works both locally and in CI.
 *
 * Runs automatically because Hexo loads all files in /scripts/.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const themeName = 'tomorrow-night-eighties';
const destPath = path.join(
  __dirname,
  '../node_modules/highlight.js/styles',
  `${themeName}.css`
);

const css = `/*
  Tomorrow Night Eighties - https://github.com/isagalaev/highlight.js
  Original theme by Chris Kempson
*/

pre code.hljs {
  display: block;
  overflow-x: auto;
  padding: 1em;
}

code.hljs {
  padding: 3px 5px;
}

.hljs {
  background: #2d2d2d;
  color: #cccccc;
}

/* Comment */
.hljs-comment,
.hljs-quote {
  color: #999999;
}

/* Red */
.hljs-variable,
.hljs-template-variable,
.hljs-tag,
.hljs-name,
.hljs-selector-id,
.hljs-selector-class,
.hljs-regexp,
.hljs-deletion {
  color: #f2777a;
}

/* Orange */
.hljs-number,
.hljs-built_in,
.hljs-literal,
.hljs-type,
.hljs-params,
.hljs-meta,
.hljs-link {
  color: #f99157;
}

/* Yellow */
.hljs-attribute {
  color: #ffcc66;
}

/* Green */
.hljs-string,
.hljs-symbol,
.hljs-bullet,
.hljs-addition {
  color: #99cc99;
}

/* Blue */
.hljs-title,
.hljs-section {
  color: #6699cc;
}

/* Purple */
.hljs-keyword,
.hljs-selector-tag {
  color: #cc99cd;
}

.hljs-emphasis {
  font-style: italic;
}

.hljs-strong {
  font-weight: bold;
}
`;

// Write only if missing (avoids unnecessary disk writes on repeated runs)
if (!fs.existsSync(destPath)) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, css, 'utf8');
  hexo.log.info(`[inject-theme] Written ${themeName}.css to highlight.js styles`);
} else {
  hexo.log.debug(`[inject-theme] ${themeName}.css already present, skipping`);
}
