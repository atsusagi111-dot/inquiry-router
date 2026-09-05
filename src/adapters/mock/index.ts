import type { Classifier, Deps } from '../../types/ports';
import { FixturesSource, parseFixturesCsv, type FixtureRow } from './fixtures-source';
import { MemoryRepo } from './memory-repo';
import { FakeClassifier, FailingClassifier } from './fake-classifier';
import { RecordingSlack, RecordingUrgent } from './recording-notifier';

export interface MockOptions {
  fixturesCsv: string;
  now?: () => Date;
  /** 'fake' = CSV の期待値を返す / 'failing' = OpenAI 断を再現 / 実装を渡せば本物（eval:llm 用） */
  classifier?: 'fake' | 'failing' | Classifier;
  failUrgent?: boolean;
}

export interface MockDeps extends Deps {
  repo: MemoryRepo;
  slack: RecordingSlack;
  urgent: RecordingUrgent;
  rows: FixtureRow[];
}

/** MOCK_EXTERNAL_API=true のときに使う Deps。外部 API 5 本すべてが差し替わる */
export function createMockDeps(opts: MockOptions): MockDeps {
  const now = opts.now ?? (() => new Date());
  const rows = parseFixturesCsv(opts.fixturesCsv);
  const mode = opts.classifier ?? 'fake';
  const classifier: Classifier =
    mode === 'fake' ? new FakeClassifier(rows) : mode === 'failing' ? new FailingClassifier() : mode;
  const urgent = new RecordingUrgent();
  urgent.failUrgent = opts.failUrgent ?? false;
  return {
    sources: [new FixturesSource('gmail', rows, now()), new FixturesSource('discord', rows, now())],
    classifier,
    slack: new RecordingSlack(),
    urgent,
    repo: new MemoryRepo(now),
    now,
    rows,
  };
}
