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
    exit 1
fi

TITLE="$1"
CATEGORY=${2:-技术}
TAGS=${3:-笔记}
SERIES=${4:-}

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
---

# $TITLE

在这里开始写作...

<!-- more -->

## 小标题

正文内容...
EOF

chmod +x "$BLOG_DIR/new_article.sh"
chmod +x "$BLOG_DIR/deploy.sh"

echo ""
echo "文章已创建: source/_posts/$FILENAME"
echo ""
echo "下一步:"
echo "  1. 编辑文章: vim source/_posts/$FILENAME"
echo "  2. 提交发布: ./deploy.sh"
