"use client";

import { useEffect } from "react";
import { consumeSupportedParam } from "@/lib/supported-param";

export function SupportedParam() {
  useEffect(() => {
    consumeSupportedParam(window);
  }, []);
  return null;
}
