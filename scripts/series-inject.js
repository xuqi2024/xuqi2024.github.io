/* eslint-disable */
/**
 * Hexo Filter: 注入 series 相关变量到 post
 * - post.series_name: 系列中文名（从 series.yml 读取）
 * - post.series_icon: 系列图标
 * - post.series_url:  /series/<id>/
 * - post.series_description: 系列描述
 */
'use strict';

const pathFn = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

let seriesMetaMap = null;
function getMetaMap() {
  if (seriesMetaMap !== null) return seriesMetaMap;
  const dataPath = pathFn.join(hexo.source_dir, '_data', 'series.yml');
  if (!fs.existsSync(dataPath)) {
    seriesMetaMap = {};
    return seriesMetaMap;
  }
  try {
    const list = yaml.load(fs.readFileSync(dataPath, 'utf8')) || [];
    const map = {};
    for (const item of list) map[item.id] = item;
    seriesMetaMap = map;
  } catch (e) {
    hexo.log.error('[series-inject] Failed to load series.yml:', e.message);
    seriesMetaMap = {};
  }
  return seriesMetaMap;
}

function enrich(post) {
  if (!post || !post.series) return;
  const meta = getMetaMap()[post.series];
  if (meta) {
    post.series_name = meta.name;
    post.series_icon = meta.icon;
    post.series_description = meta.description;
  } else {
    post.series_name = post.series;
    post.series_icon = '📑';
    post.series_description = '';
  }
  post.series_url = `/series/${post.series}/`;
}

// 给每个 post 注入
hexo.extend.filter.register('before_post_render', function (data) {
  if (data.layout === 'post' || !data.layout) {
    enrich(data);
  }
  return data;
}, 9);

// 给 site.posts 注入（用于模板迭代）
hexo.extend.filter.register('template_locals', function (locals) {
  if (locals.page && locals.page.layout === 'post') {
    enrich(locals.page);
  }
  if (locals.post) {
    enrich(locals.post);
  }
  if (locals.posts && Array.isArray(locals.posts)) {
    locals.posts.forEach(p => enrich(p));
  }
  return locals;
});
