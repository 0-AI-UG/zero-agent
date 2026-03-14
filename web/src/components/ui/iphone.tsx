import type { HTMLAttributes, ReactNode } from "react";

export interface IphoneProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function Iphone({
  children,
  className,
  ...props
}: IphoneProps) {
  return (
    <div
      className={`relative mx-auto w-full ${className ?? ""}`}
      {...props}
    >
      {/* iPhone frame */}
      <div className="rounded-[3rem] border-[6px] border-neutral-800 bg-neutral-800 shadow-xl dark:border-neutral-700">
        {/* Notch / Dynamic Island */}
        <div className="flex justify-center pt-[6px] pb-[4px] bg-black rounded-t-[2.6rem]">
          <div className="h-[22px] w-[90px] rounded-full bg-neutral-900 flex items-center justify-end pr-[6px]">
            <div className="size-[10px] rounded-full bg-neutral-800 ring-[2px] ring-neutral-700/50" />
          </div>
        </div>

        {/* Screen */}
        <div className="bg-black">
          <div className="overflow-hidden">
            {children}
          </div>
        </div>

        {/* Home indicator area */}
        <div className="flex justify-center bg-black pb-[8px] pt-[4px] rounded-b-[2.6rem]">
          <div className="h-[4px] w-[100px] rounded-full bg-neutral-600" />
        </div>
      </div>
    </div>
  );
}
