# 하루 1회 자동 업데이트 운영 메모

이 사이트는 프론트엔드에서 TMDB 토큰을 직접 쓰지 않습니다.
토큰을 브라우저에 넣으면 공개되어 버리기 때문에, GitHub Actions가 하루 한 번 서버 쪽 작업처럼 실행되어 정적 데이터 파일만 갱신합니다.

## 동작 흐름

1. GitHub Actions가 매일 13:00 UTC에 실행됩니다.
2. 한국 시간으로는 매일 22:00 KST입니다.
3. `scripts/update-releases.mjs`가 TMDB/JustWatch에서 실제 극장 개봉작과 OTT/디지털 공개작을 가져옵니다.
4. 영화 제목, 개봉/공개일, 장르, 포스터, 러닝타임, 등급, OTT 제공처를 `data/releases.json`과 `data/releases.js`에 씁니다.
5. 변경이 있으면 자동 커밋합니다.
6. 정적 호스팅이 저장소 변경을 감지해 사이트를 다시 배포합니다.

## 선택 secret

```text
TMDB_BEARER_TOKEN
```

공개 웹 수집은 토큰 없이도 동작합니다.
더 안정적인 TMDB 공식 API 수집을 원하면 GitHub 저장소에서 Settings -> Secrets and variables -> Actions -> New repository secret 순서로 `TMDB_BEARER_TOKEN`을 추가합니다.

## 운영자가 매일 할 일

없습니다.
GitHub Actions가 켜져 있으면 매일 자동으로 갱신됩니다.

## 실패 시 동작

TMDB/JustWatch 조회가 실패하면 작업이 실패합니다.
실패한 작업은 데이터 파일을 커밋하지 않으므로 마지막으로 성공한 실제 데이터가 유지됩니다.
