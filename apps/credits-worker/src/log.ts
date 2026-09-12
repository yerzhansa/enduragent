export type LogFields = {
  route: string;
  athleteId?: string;
  transactionId?: string;
  outcome: string;
};

export type RedactingLog = {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
};

export const consoleLog: RedactingLog = {
  info(fields) {
    console.log(JSON.stringify(fields));
  },
  warn(fields) {
    console.warn(JSON.stringify(fields));
  },
};
