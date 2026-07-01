#!/usr/bin/env bash
set -e

cd /opt/piclaw

echo '=== 1/2 构建所有 workspace（packages）==='
npm run build --workspaces --if-present

echo ''
echo '=== 重启服务 ==='
systemctl restart piclaw-web.service
sleep 3
systemctl status piclaw-web.service --no-pager | head -10

echo ''
echo -n '健康检查: '
curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:30142/
echo ''
echo '完成 ✅'
