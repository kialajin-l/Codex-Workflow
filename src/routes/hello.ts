export interface HelloResponse {
  message: string;
}

export function handleHello(): HelloResponse {
  return { message: "Hello, World!" };
}
