@echo off
cd /d D:\Program\mekiki-bot
call node dist/index.js --once >> logs\scheduled.log 2>&1
