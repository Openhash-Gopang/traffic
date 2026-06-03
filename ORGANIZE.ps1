# K-Traffic 디렉토리 정리 스크립트
# C:\Users\주피터\Downloads\traffic> 에서 실행하세요

# 1. docs 폴더 생성
New-Item -ItemType Directory -Force -Path "docs" | Out-Null

# 2. whitepaper 이동
Move-Item -Path "k-traffic-whitepaper.md" -Destination "docs\k-traffic-whitepaper.md" -Force

Write-Host "✅ 정리 완료" -ForegroundColor Green
Write-Host ""
Write-Host "최종 구조:" -ForegroundColor Cyan
tree /F
