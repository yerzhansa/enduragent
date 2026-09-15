export type IntervalsTokens = {
  accessToken: string;
  refreshToken: string;
};

export type IntervalsOAuth = {
  exchange(authorizationCode: string): Promise<IntervalsTokens>;
};

export class IntervalsOAuthClient implements IntervalsOAuth {
  constructor(private readonly clientSecret: string) {}
  exchange(_authorizationCode: string): Promise<IntervalsTokens> {
    throw new Error("not implemented");
  }
}
