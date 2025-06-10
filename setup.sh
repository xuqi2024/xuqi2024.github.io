#!/bin/bash

# 设置错误时退出
set -e

# 显示执行的命令
set -x

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}开始安装 Hexo 环境...${NC}"

# 1. 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo -e "${RED}未检测到 Node.js，请先安装 Node.js${NC}"
    echo -e "${BLUE}您可以从 https://nodejs.org 下载安装${NC}"
    exit 1
fi

# 2. 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo -e "${RED}未检测到 npm，请先安装 npm${NC}"
    exit 1
fi

# 3. 安装 Hexo CLI
echo -e "${GREEN}安装 Hexo CLI...${NC}"
npm install -g hexo-cli

# 4. 创建临时目录并初始化 Hexo 项目
echo -e "${GREEN}创建临时目录并初始化 Hexo 项目...${NC}"
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"
hexo init .

# 5. 将生成的文件复制回原目录
echo -e "${GREEN}复制文件到原目录...${NC}"
cp -r * ..
cp -r .* .. 2>/dev/null || true
cd ..
rm -rf "$TEMP_DIR"

# 6. 安装必要的依赖
echo -e "${GREEN}安装项目依赖...${NC}"
npm install

# 7. 安装部署插件
echo -e "${GREEN}安装部署插件...${NC}"
npm install hexo-deployer-git --save

# 8. 安装 NexT 主题
echo -e "${GREEN}安装 NexT.Muse 主题...${NC}"
git clone https://github.com/next-theme/hexo-theme-next themes/next

# 9. 创建基本配置文件
echo -e "${GREEN}创建基本配置文件...${NC}"

# 创建 _config.yml 文件（如果不存在）
if [ ! -f "_config.yml" ]; then
    cat > _config.yml << EOL
# Hexo Configuration
## Docs: https://hexo.io/docs/configuration.html

# Site
title: 我的博客
subtitle: '程序员的自我修养'
description: '读书笔记和技术分享'
keywords: 程序员,读书笔记,技术分享
author: Your Name
language: zh-CN
timezone: 'Asia/Shanghai'

# URL
url: http://your-domain.com
permalink: posts/:abbrlink.html
abbrlink:
  alg: crc32
  rep: dec

# Directory
source_dir: source
public_dir: public
tag_dir: tags
archive_dir: archives
category_dir: categories
code_dir: downloads/code
i18n_dir: :lang
skip_render:

# Writing
new_post_name: :title.md
default_layout: post
titlecase: false
external_link:
  enable: true
  field: site
  exclude: ''
filename_case: 0
render_drafts: false
post_asset_folder: false
relative_link: false
future: true
highlight:
  enable: true
  line_number: true
  auto_detect: false
  tab_replace: ''
  wrap: true
  hljs: false
prismjs:
  enable: false
  preprocess: true
  line_number: true
  tab_replace: ''

# Category & Tag
default_category: uncategorized
category_map:
tag_map:

# Date / Time format
date_format: YYYY-MM-DD
time_format: HH:mm:ss

# Pagination
per_page: 10
pagination_dir: page

# Include / Exclude file(s)
include:
exclude:
ignore:

# Extensions
theme: next
deploy:
  type: git
  repo: <repository url>
  branch: [branch]
  message: [message]
EOL
fi

# 创建主题配置文件
if [ ! -f "themes/next/_config.yml" ]; then
    cp themes/next/_config.yml themes/next/_config.yml.backup
    cat > themes/next/_config.yml << EOL
# NexT 主题配置
# Docs: https://theme-next.js.org/docs/

# 选择主题风格
scheme: Muse

# 菜单配置
menu:
  home: / || fa fa-home
  about: /about/ || fa fa-user
  tags: /tags/ || fa fa-tags
  categories: /categories/ || fa fa-th
  archives: /archives/ || fa fa-archive

# 社交链接
social:
  GitHub: https://github.com/yourusername || fab fa-github
  E-Mail: mailto:your-email@example.com || fa fa-envelope

# 侧边栏
sidebar:
  position: left
  display: post
  offset: 12
  b2t: false
  scrollpercent: false

# 页脚
footer:
  since: 2024
  icon:
    name: fa fa-heart
    animated: true
    color: "#ff0000"
  powered: true
  beian: false

# 本地搜索
local_search:
  enable: true

# 返回顶部
back2top:
  enable: true
  sidebar: false
  scrollpercent: true
EOL
fi

echo -e "${GREEN}Hexo 环境安装完成！${NC}"
echo -e "${BLUE}请修改 _config.yml 中的配置信息，特别是：${NC}"
echo -e "${BLUE}1. 网站标题、作者等信息${NC}"
echo -e "${BLUE}2. 部署仓库地址${NC}"
echo -e "${BLUE}3. 社交链接${NC}"
echo -e "${BLUE}配置完成后，运行 ./deploy.sh 即可部署博客${NC}" 