#!/bin/bash

# 设置错误时退出
set -e

# 显示执行的命令
set -x

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}开始部署博客...${NC}"

# 1. 清理之前的生成文件
echo -e "${GREEN}清理之前的生成文件...${NC}"
hexo clean

# 2. 生成静态文件
echo -e "${GREEN}生成静态文件...${NC}"
hexo generate

# 3. 检查生成是否成功
if [ $? -eq 0 ]; then
    echo -e "${GREEN}静态文件生成成功！${NC}"
else
    echo -e "${RED}静态文件生成失败，请检查错误信息${NC}"
    exit 1
fi

# 4. 部署到服务器
echo -e "${GREEN}开始部署到服务器...${NC}"
hexo deploy

# 5. 检查部署是否成功
if [ $? -eq 0 ]; then
    echo -e "${GREEN}部署成功！${NC}"
    echo -e "${BLUE}博客已经成功部署到服务器${NC}"
else
    echo -e "${RED}部署失败，请检查错误信息${NC}"
    exit 1
fi

# 6. 清理临时文件
echo -e "${GREEN}清理临时文件...${NC}"
rm -rf .deploy_git/

echo -e "${BLUE}部署完成！${NC}" 