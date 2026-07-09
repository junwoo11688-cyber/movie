# 개봉/OTT 캘린더

극장 개봉작과 OTT/디지털 공개작을 월간 캘린더로 보는 정적 사이트입니다.

## 실제 데이터 자동 업데이트

이 사이트는 사용자가 매일 직접 업데이트하지 않습니다.
GitHub Actions가 매일 22:00 KST에 실행되어 실제 개봉/OTT 데이터를 가져오고, `data/releases.json`과 `data/releases.js`를 자동으로 갱신합니다.

초기 파일은 빈 캐시입니다.
첫 자동 업데이트가 성공하면 실제 영화 제목, 개봉/공개일, 장르, 포스터, 러닝타임, 관람등급, OTT 제공처가 채워집니다.

## 최초 설정

1. 이 폴더를 GitHub 저장소 루트로 올립니다.
2. GitHub Pages, Netlify, Cloudflare Pages 같은 정적 호스팅으로 배포합니다.
3. 이후 `.github/workflows/daily-update.yml`이 매일 자동으로 실제 데이터를 갱신합니다.
4. 더 안정적인 공식 API 수집을 원하면 저장소 Settings -> Secrets and variables -> Actions -> New repository secret에 `TMDB_BEARER_TOKEN`을 추가합니다.

브라우저에 TMDB 토큰을 넣지 않습니다.
토큰을 설정한 경우에도 GitHub Actions 안에서만 사용되고, 사이트에는 정적 JSON/JS 데이터만 배포됩니다.

## 데이터 소스

토큰이 있으면 극장 일정은 TMDB의 한국 지역 release type 2, 3을 사용하고, OTT/디지털 일정은 TMDB의 release type 4와 watch provider 데이터를 조합합니다.
토큰이 없으면 TMDB 공개 현재 상영/개봉 예정 페이지와 JustWatch Korea 최신 영화 페이지를 수집합니다.
OTT 항목은 Netflix, Wavve, TVING, Disney+, Watcha, Laftel만 남기고 다른 제공처는 제거합니다.

## 생성되는 파일

```text
data/releases.json
data/releases.js
```

`index.html`은 서버 배포 환경에서는 `releases.json`을 우선 불러오고, 로컬 파일 열기 환경에서는 `releases.js`를 사용합니다.

## 실패 동작

실제 데이터 조회가 실패하면 자동 작업이 실패합니다.
그 경우 기존 최신 데이터는 유지되고, 빈 데이터로 사이트를 덮어쓰지 않습니다.

## 출처 표기

실데이터 배포 시 TMDB 및 JustWatch 표기 조건을 확인해 푸터나 데이터 영역에 함께 표시하세요.
