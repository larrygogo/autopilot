import React, { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// 常用时区（覆盖全球主要市场；置顶方便选择）
const POPULAR_TZ = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Seoul",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const POPULAR_SET = new Set(POPULAR_TZ);

const SYSTEM_VALUE = "__system__";

function allTimezones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (s: string) => string[] })
    .supportedValuesOf;
  if (typeof fn === "function") {
    try {
      return fn("timeZone");
    } catch {
      /* fallthrough */
    }
  }
  return POPULAR_TZ;
}

function groupByRegion(zones: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const tz of zones) {
    if (POPULAR_SET.has(tz)) continue;
    const region = tz.split("/")[0];
    if (!groups[region]) groups[region] = [];
    groups[region].push(tz);
  }
  for (const key of Object.keys(groups)) groups[key].sort();
  return groups;
}

interface Props {
  /** 空字符串 / null 表示"跟随系统" */
  value: string | null;
  onChange: (value: string | null) => void;
  systemTz?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function TimezoneSelect({
  value,
  onChange,
  systemTz,
  disabled,
  placeholder = "选择时区",
  className,
}: Props) {
  const grouped = useMemo(() => groupByRegion(allTimezones()), []);
  const selectValue = value && value.trim() ? value : SYSTEM_VALUE;

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => onChange(v === SYSTEM_VALUE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-[360px]">
        <SelectGroup>
          <SelectLabel>系统</SelectLabel>
          <SelectItem value={SYSTEM_VALUE}>
            跟随系统{systemTz ? ` · ${systemTz}` : ""}
          </SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>常用</SelectLabel>
          {POPULAR_TZ.map((tz) => (
            <SelectItem key={tz} value={tz} className="font-mono text-xs">
              {tz}
            </SelectItem>
          ))}
        </SelectGroup>
        {Object.entries(grouped).map(([region, zones]) => (
          <React.Fragment key={region}>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{region}</SelectLabel>
              {zones.map((tz) => (
                <SelectItem key={tz} value={tz} className="font-mono text-xs">
                  {tz}
                </SelectItem>
              ))}
            </SelectGroup>
          </React.Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}
