export type LogFields = {
  route: string;
  outcome: string;
};

export type RedactingLog = {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
};

export const consoleLog: RedactingLog = {
  info(fields) {
    console.log(JSON.stringify({ route: fields.route, outcome: fields.outcome }));
  },
  warn(fields) {
    console.warn(JSON.stringify({ route: fields.route, outcome: fields.outcome }));
  },
};
