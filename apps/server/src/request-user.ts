export type RequestUser = {
  userId: string;
  email: string;
  accessToken: string;
};

export const LOCAL_USER: RequestUser = {
  userId: "00000000-0000-0000-0000-000000000001",
  email: "local@yui.invalid",
  accessToken: "local",
};

declare module "fastify" {
  interface FastifyRequest {
    yuiUser: RequestUser;
  }
}
