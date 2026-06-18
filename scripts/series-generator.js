/* eslint-disable */
/**
 * Hexo Generator: series
 * - 从所有文章的 frontmatter.series 字段聚合
 * - 为每个 series 生成两个 page：
 *   1. /series/                  总览页（所有 series 卡片）
 *   2. /series/<id>/             该 series 的文章列表
 * - 从 source/_data/series.yml 读取显示名
 */
'use strict';

const pathFn = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

function loadSeriesConfig() {
  const dataPath = pathFn.join(hexo.source_dir, '_data', 'series.yml');
  if (!fs.existsSync(dataPath)) return [];
  try {
    return yaml.load(fs.readFileSync(dataPath, 'utf8')) || [];
  } catch (e) {
    hexo.log.error('[series-generator] Failed to load series.yml:', e.message);
    return [];
  }
}

function seriesMetaMap() {
  const list = loadSeriesConfig();
  const map = {};
  for (const item of list) {
    map[item.id] = item;
  }
  return map;
}

function groupPostsBySeries(site) {
  const groups = {};
  site.posts.forEach(post => {
    const sid = post.series;
    if (!sid) return;
    if (!groups[sid]) groups[sid] = [];
    groups[sid].push(post);
  });
  // 按 order 字段排序
  return groups;
}

function sortSeries(groups, metaMap) {
  return Object.entries(groups).map(([id, posts]) => {
    const meta = metaMap[id] || { name: id, icon: '📑', description: '', order: 999, category: '' };
    posts.sort((a, b) => (a.date || 0) - (b.date || 0));
    return { id, posts, meta, count: posts.length };
  }).sort((a, b) => (a.meta.order || 999) - (b.meta.order || 999));
}

function register() {
  // /series/<id>/  每个系列的详情页
  hexo.extend.generator.register('series-detail', function (site) {
    const metaMap = seriesMetaMap();
    const groups = groupPostsBySeries(site);
    return sortSeries(groups, metaMap).map(({ id, posts, meta }) => ({
      path: `series/${id}/`,
      layout: ['series-detail'],
      data: {
        type: 'series-detail',
        series_id: id,
        series_name: meta.name,
        series_icon: meta.icon,
        series_description: meta.description,
        series_category: meta.category,
        posts: posts.map(p => ({
          title: p.title,
          permalink: p.permalink,
          path: p.path,
          date: p.date,
          excerpt: p.excerpt || '',
        })),
      },
    }));
  });

  // /series/  总览页
  hexo.extend.generator.register('series-index', function (site) {
    const metaMap = seriesMetaMap();
    const groups = groupPostsBySeries(site);
    const seriesList = sortSeries(groups, metaMap);
    return {
      path: 'series/',
      layout: ['series-index'],
      data: {
        type: 'series-index',
        series_list: seriesList,
        total_series: seriesList.length,
        total_posts: site.posts.length,
      },
    };
  });
}

register();
