export interface Message {
  readonly key: string;
  readonly vars?: Record<string, string | number>;
}

export function msg(key: string, vars?: Record<string, string | number>): Message {
  return vars === undefined ? { key } : { key, vars };
}
