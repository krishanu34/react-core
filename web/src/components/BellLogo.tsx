import Image from "next/image";

export function BellLogo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <Image
        src="/bell-logo.svg"
        alt="Bell"
        width={52}
        height={30}
        priority
        style={{ height: "30px", width: "auto" }}
      />
      <span aria-hidden className="h-6 w-px bg-white/30" />
      <span className="text-lg font-semibold leading-none text-white sm:text-xl">
        TAG Engine
      </span>
    </div>
  );
}

