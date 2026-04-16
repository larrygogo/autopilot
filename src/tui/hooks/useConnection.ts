import { useState, useEffect } from "react";
import type { AutopilotClient } from "../../client/index";
import type { ConnectionState } from "../../client/ws";

export function useConnection(client: AutopilotClient): ConnectionState {
  const [state, setState] = useState<ConnectionState>(client.connectionState);

  useEffect(() => {
    return client.onStateChange(setState);
  }, [client]);

  return state;
}
