#!/usr/bin/env bash
# OX 퀴즈 라이브 → GCP Cloud Run 배포 (단일 인스턴스). 근거: DOCS/decisions/ADR-0004-cloud-deploy.md
# 사용: PROJECT=my-proj REGION=asia-northeast3 HOST_PIN=123456 SCREEN_KEY=... [GCS_BUCKET=...] ./deploy/cloud-run.sh
# 행사 중에는 절대 실행하지 않는다(인스턴스 교체로 인메모리 상태 소실). 행사 전날 배포 동결.
set -euo pipefail

PROJECT="${PROJECT:?GCP 프로젝트 ID (PROJECT) 필요}"
REGION="${REGION:-asia-northeast3}"
SERVICE="${SERVICE:-ox-quiz}"
HOST_PIN="${HOST_PIN:?사회자 PIN (HOST_PIN) 필요}"
SCREEN_KEY="${SCREEN_KEY:?스크린 키 (SCREEN_KEY) 필요}"
GCS_BUCKET="${GCS_BUCKET:-}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

echo "▶ 프로젝트 $PROJECT / 리전 $REGION / 서비스 $SERVICE"
gcloud config set project "$PROJECT" >/dev/null

ENV_VARS="NODE_ENV=production,HOST_PIN=${HOST_PIN},SCREEN_KEY=${SCREEN_KEY},RETENTION_DAYS=${RETENTION_DAYS}"
if [[ -n "$GCS_BUCKET" ]]; then
  ENV_VARS="${ENV_VARS},GCS_BUCKET=${GCS_BUCKET}"
  if ! gcloud storage buckets describe "gs://${GCS_BUCKET}" >/dev/null 2>&1; then
    echo "▶ 스냅샷 버킷 생성 gs://${GCS_BUCKET}"
    gcloud storage buckets create "gs://${GCS_BUCKET}" --location="$REGION" --uniform-bucket-level-access
  fi
fi

echo "▶ 소스 빌드·배포 (Cloud Build, Dockerfile 사용)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 1000 \
  --no-cpu-throttling \
  --cpu 1 --memory 512Mi \
  --timeout 3600 \
  --session-affinity \
  --set-env-vars "$ENV_VARS"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "▶ 서비스 URL: $URL → PUBLIC_URL 반영(QR에 들어가는 주소)"
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=${URL}" >/dev/null

if [[ -n "$GCS_BUCKET" ]]; then
  SA="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')"
  SA="${SA:-$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"
  echo "▶ 서비스 계정 $SA 에 버킷 objectAdmin 부여"
  gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin >/dev/null
fi

echo
echo "완료. 확인:"
echo "  curl ${URL}/api/health"
echo "  사회자 콘솔  ${URL}/host   (PIN)"
echo "  스크린       ${URL}/screen (첫 접속 때 SCREEN_KEY 입력)"
echo "  참가자       ${URL}/join   (QR은 콘솔 설정 탭에서 저장)"
