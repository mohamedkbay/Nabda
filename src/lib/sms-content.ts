const GSM_7_BASIC = new Set([
  ..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
]);
const GSM_7_EXTENSION = new Set([..."^{}\\[~]|€\f"]);

export interface SmsContentMeasure {
  encoding: "gsm7" | "ucs2";
  units: number;
  singleSegmentLimit: number;
  fitsSingleSegment: boolean;
}

export function measureSmsContent(content: string): SmsContentMeasure {
  let septets = 0;
  let gsm7 = true;
  for (const character of content) {
    if (GSM_7_BASIC.has(character)) septets += 1;
    else if (GSM_7_EXTENSION.has(character)) septets += 2;
    else {
      gsm7 = false;
      break;
    }
  }

  if (gsm7) {
    return {
      encoding: "gsm7",
      units: septets,
      singleSegmentLimit: 160,
      fitsSingleSegment: septets <= 160,
    };
  }

  const codeUnits = content.length;
  return {
    encoding: "ucs2",
    units: codeUnits,
    singleSegmentLimit: 70,
    fitsSingleSegment: codeUnits <= 70,
  };
}
