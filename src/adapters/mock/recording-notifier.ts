import type { Inquiry } from '../../types/inquiry';
import type { SlackNotifier, UrgentNotifier } from '../../types/ports';

/** 送った内容を配列に溜めるだけ。テストで「何回・どこに送ったか」を検証する */
export class RecordingSlack implements SlackNotifier {
  readonly posts: { channel: string; inquiry: Inquiry }[] = [];
  async post(channel: string, inquiry: Inquiry) { this.posts.push({ channel, inquiry }); }
}

export class RecordingUrgent implements UrgentNotifier {
  readonly urgent: Inquiry[] = [];
  readonly ops: string[] = [];
  /** true にすると Discord 障害を再現し、dead_letter への退避を検証できる */
  failUrgent = false;
  async notifyUrgent(inquiry: Inquiry) {
    if (this.failUrgent) throw new Error('mock: Discord に接続できません');
    this.urgent.push(inquiry);
  }
  async notifyOps(message: string) { this.ops.push(message); }
}
