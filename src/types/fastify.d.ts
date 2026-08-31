import type { ApiPrincipal, DeviceAgentPrincipal } from "../domain/types.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: ApiPrincipal;
    devicePrincipal?: DeviceAgentPrincipal;
  }
}
