# xuqi2024 学习笔记

博客地址: https://xuqi2024.github.io

## 快速开始

### 1. SSH 到服务器
```bash
ssh xuqi@192.168.1.8
cd ~/blog
```

### 2. 创建新文章
```bash
# 用法: ./new_article.sh "标题" 分类 标签
./new_article.sh "我的第一篇笔记" 技术 笔记
```

### 3. 编辑文章
```bash
vim source/_posts/2026-04-13-我的第一篇笔记.md
```

### 4. 提交发布（自动构建部署）
```bash
./deploy.sh
```

## 自动化说明

- `git push` 后 GitHub Actions 自动执行 `hexo generate`
- 构建完成后自动部署到 GitHub Pages
- 无需手动操作，约 1-2 分钟完成

## 目录结构

```
blog/
├── source/_posts/       # 文章目录 (Markdown)
│   └── YYYY-MM-DD-标题.md
├── public/              # 生成的静态文件
├── themes/next/         # Next 主题
├── _config.yml          # Hexo 配置
├── deploy.sh            # 部署脚本
└── .github/workflows/  # GitHub Actions
```

## 文章格式

```markdown
---
title: 文章标题
date: 2026-04-13 12:00:00 +0800
categories: 技术
tags: [笔记, Git]
---

# 标题

摘要内容...

<!-- more -->

正文内容...

## 代码示例

\`\`\`python
print("Hello World")
\`\`\`

## 图片

```markdown
![图片描述](/blog/images/图片.png)
```

## 查看状态

构建状态: https://github.com/xuqi2024/xuqi2024.github.io/actions
```

## 常用命令

```bash
hexo clean     # 清理缓存
hexo generate  # 生成静态文件
hexo server    # 本地预览
hexo deploy    # 部署
```
