#!/bin/bash
set -e

BLOG_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BLOG_DIR"

echo "=== 创建新文章 ==="

# 获取日期
DATE=$(date +%Y-%m-%d)

# 解析参数
if [ $# -eq 0 ]; then
    echo "用法: ./new_article.sh <标题> [分类] [标签] [系列ID]"
    echo "示例: ./new_article.sh 我的笔记 技术 笔记,Git hello-agents"
    echo ""
    echo "系列 ID 可在 source/_data/series.yml 中查得。"
    echo "当前可用系列:"
    grep -E "^- id:" source/_data/series.yml 2>/dev/null | sed 's/- id:/  /' | head -20
    echo ""
    echo "注意: 系列 ID 必须是 source/_data/series.yml 中定义的 id 之一"
    echo "     创建后请同步编辑 source/_data/series.yml 添加新系列"
    exit 1
fi

TITLE="$1"
CATEGORY=${2:-技术分析}
TAGS=${3:-笔记}
SERIES=${4:-}

# 校验 series ID
if [ -n "$SERIES" ] && [ -f source/_data/series.yml ]; then
    if ! grep -qE "^- id: ${SERIES}$" source/_data/series.yml 2>/dev/null; then
        echo "⚠️  警告: 系列 ID '${SERIES}' 不在 source/_data/series.yml 中"
        echo "   可用系列: $(grep -E '^- id:' source/_data/series.yml | sed 's/- id: //' | tr '\n' ' ')"
        echo "   继续创建 (稍后请补 series.yml) ... (3s)"
        sleep 3
    fi
fi

# 生成文件名
FILENAME="${DATE}-$(echo "$TITLE" | sed 's/[^a-zA-Z0-9一-龥]/-/g' | tr '[:upper:]' '[:lower:]').md"

# 构建 series 字段
SERIES_LINE=""
if [ -n "$SERIES" ]; then
    SERIES_LINE="series: $SERIES"
fi

# 创建文件
cat > "$BLOG_DIR/source/_posts/$FILENAME" << EOF
---
title: $TITLE
date: $DATE $((RANDOM % 24)):$(printf "%02d" $((RANDOM % 60))):00 +0800
categories: $CATEGORY
tags: [$TAGS]
${SERIES_LINE}
description:
---

# $TITLE

> 一句话核心结论（引用块）

<!-- more -->

## 前言

在这里开始写作...

## 小标题

正文内容...
EOF

chmod +x "$BLOG_DIR/new_article.sh"
chmod +x "$BLOG_DIR/deploy.sh"

echo ""
echo "文章已创建: source/_posts/$FILENAME"
echo ""
echo "⚠️  下一步:"
echo "  1. 编辑文章: vim source/_posts/$FILENAME"
echo "  2. ⚠️  必须填上 description 字段（不能含双引号）"
echo "  3. 提交发布: ./deploy.sh"

if [ -n "$SERIES" ]; then
    if ! grep -qE "^- id: ${SERIES}$" source/_data/series.yml 2>/dev/null; then
        echo ""
        echo "📌 提醒: 还需在 source/_data/series.yml 中添加系列定义："
        echo "  - id: ${SERIES}"
        echo "    name: ${SERIES}"
        echo "    description: 请补充"
        echo "    icon: 📑"
        echo "    category: ${CATEGORY}"
        echo "    order: 99"
    fi
fi
