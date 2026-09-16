// SQLite 스냅샷을 GCS에 복사한다(선택 기능, GCS_BUCKET 설정 시). Cloud Run의 디스크는 인스턴스와 함께 사라지므로
// 저장마다 2초 디바운스로 `VACUUM INTO` 사본을 만들어 올리고, 기동 시 로컬 파일이 없으면 내려받는다.
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

type StorageModule = typeof import('@google-cloud/storage');

export interface Snapshotter {
  /** 저장 직후 호출. 실제 업로드는 디바운스 */
  schedule(): void;
  /** 종료 전 대기 중인 업로드를 마저 보낸다 */
  flush(): Promise<void>;
}

async function loadStorage(): Promise<StorageModule | null> {
  try {
    return await import('@google-cloud/storage');
  } catch {
    return null;
  }
}

const OBJECT_NAME = 'ox.sqlite';

/** 로컬 DB 파일이 없으면 버킷에서 복원. 성공하면 true */
export async function restoreFromGcs(bucket: string, dbPath: string, log: (m: string) => void): Promise<boolean> {
  if (existsSync(dbPath)) return false;
  const mod = await loadStorage();
  if (!mod) {
    log('GCS_BUCKET이 설정됐지만 @google-cloud/storage 모듈이 없어 복원을 건너뜁니다.');
    return false;
  }
  try {
    const file = new mod.Storage().bucket(bucket).file(OBJECT_NAME);
    const [exists] = await file.exists();
    if (!exists) return false;
    mkdirSync(dirname(dbPath), { recursive: true });
    await file.download({ destination: dbPath });
    log(`GCS gs://${bucket}/${OBJECT_NAME} 에서 SQLite 복원`);
    return true;
  } catch (e) {
    log(`GCS 복원 실패: ${(e as Error).message}`);
    return false;
  }
}

export function createSnapshotter(
  bucket: string,
  makeCopy: (path: string) => void,
  dbPath: string,
  log: (m: string) => void,
  debounceMs = 2000,
): Snapshotter {
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> | null = null;
  let dirty = false;
  const copyPath = `${dbPath}.snapshot`;

  const upload = async () => {
    const mod = await loadStorage();
    if (!mod) return;
    try {
      makeCopy(copyPath);
      await new mod.Storage().bucket(bucket).upload(copyPath, { destination: OBJECT_NAME, resumable: false });
    } catch (e) {
      log(`GCS 스냅샷 업로드 실패: ${(e as Error).message}`);
    } finally {
      try {
        if (existsSync(copyPath)) unlinkSync(copyPath);
      } catch {
        /* 무시 */
      }
    }
  };

  const run = () => {
    timer = null;
    dirty = false;
    inflight = upload().finally(() => {
      inflight = null;
      if (dirty) schedule();
    });
  };

  const schedule = () => {
    dirty = true;
    if (inflight) return; // 끝나면 dirty를 보고 다시 예약
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };

  return {
    schedule,
    async flush() {
      if (timer) {
        clearTimeout(timer);
        run();
      }
      if (inflight) await inflight;
    },
  };
}
