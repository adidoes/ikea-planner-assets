import * as React from "react";

import { cn } from "@/lib/utils";

function Progress({ className, value = 0, ...props }: React.ComponentProps<"div"> & { value?: number }) {
  const normalized = Math.min(100, Math.max(0, value));
  return (
    <div
      data-slot="progress"
      className={cn("ui-progress", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalized}
      {...props}
    >
      <span style={{ transform: `translateX(-${100 - normalized}%)` }} />
    </div>
  );
}

export { Progress };
