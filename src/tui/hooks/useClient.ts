import { useRef, useEffect } from "react";
import { AutopilotClient, DEFAULT_PORT } from "../../client/index";

export function useClient(port = DEFAULT_PORT): AutopilotClient {
  const clientRef = useRef<AutopilotClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = new AutopilotClient({ port });
  }

  useEffect(() => {
    const client = clientRef.current!;
    client.connect();
    return () => client.disconnect();
  }, []);

  return clientRef.current;
}
