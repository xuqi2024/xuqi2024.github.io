#!/bin/bash
set -e

BLOG_DIR="/home/xuqi/blog"
cd $BLOG_DIR

echo "=== 创建新文章 ==="

# 获取日期
DATE=$(date +%Y-%m-%d)

# 解析参数
if [ $# -eq 0 ]; then
    echo "用法: ./new_article.sh <标题> [分类] [标签]"
    echo "示例: ./new_article.sh 我的笔记 技术 笔记,Git"
    exit 1
fi

TITLE="$1"
CATEGORY=${2:-技术}
TAGS=${3:-笔记}

# 生成文件名
FILENAME="${DATE}-$(echo $TITLE | sed 's/[^a-zA-Z0-9\u4e00-\u9fa5]/-/g' | tr '[:upper:]' '[:lower:]').md"

# 创建文件
cat > "$BLOG_DIR/source/_posts/$FILENAME" << EOF
---
title: $TITLE
date: $DATE $((RANDOM % 24)):$(printf "%02d" $((RANDOM % 60))):00 +0800
categories: $CATEGORY
tags: [$TAGS]
---

# $TITLE

在这里开始写作...

<!-- more -->

## 小标题

正文内容...
EOF

chmod +x $BLOG_DIR/new_article.sh
chmod +x $BLOG_DIR/deploy.sh

echo ""
echo "文章已创建: source/_posts/$FILENAME"
echo ""
echo "下一步:"
echo "  1. 编辑文章: vim source/_posts/$FILENAME"
echo "  2. 提交发布: ./deploy.sh"
