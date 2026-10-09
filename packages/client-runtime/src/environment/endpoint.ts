import { environmentRoutePrefix } from "@t3tools/shared/advertisedEndpoint";
export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${environmentRoutePrefix(url.pathname)}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
