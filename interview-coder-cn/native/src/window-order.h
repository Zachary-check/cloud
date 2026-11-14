#pragma once
#include <windows.h>
#include <dwmapi.h>
#include <string>

// Observe ordering and overlap only. The Electron owner restores its own windows;
// this helper never changes another application's windows or input focus.
inline bool guardBounds(HWND hwnd, RECT& bounds) {
  if(!hwnd||!IsWindow(hwnd)||!IsWindowVisible(hwnd)||IsIconic(hwnd)||!GetWindowRect(hwnd,&bounds)) return false;
  if(bounds.right<=bounds.left||bounds.bottom<=bounds.top||!MonitorFromRect(&bounds,MONITOR_DEFAULTTONULL)) return false;
  COLORREF key=0; BYTE alpha=255; DWORD flags=0;
  if(GetLayeredWindowAttributes(hwnd,&key,&alpha,&flags)&&(flags&LWA_ALPHA)&&alpha==0) return false;
  return true;
}
inline bool guardPlatform(HWND hwnd, const std::wstring& selected) {
  wchar_t title[512]{}; GetWindowTextW(hwnd,title,512);
  std::wstring caption=title; std::transform(caption.begin(),caption.end(),caption.begin(),towlower);
  // The title also covers branded login windows hosted by a different executable.
  const bool iguokaoTitle=caption.find(L"国考云")!=std::wstring::npos||caption.find(L"iguokao")!=std::wstring::npos;
  if((selected==L"auto"||selected==L"iguokao")&&iguokaoTitle) return true;
  DWORD pid=0; GetWindowThreadProcessId(hwnd,&pid); const auto name=processName(pid);
  return ((selected==L"auto"||selected==L"iguokao")&&(name==L"国考云.exe"||name==L"iguokao.exe"))||
    ((selected==L"auto"||selected==L"shixizhi")&&name==L"shixizhiclient.exe")||
    ((selected==L"auto"||selected==L"eztest")&&name==L"eztest.exe");
}
inline bool platformCoversOverlay(HWND main, HWND toolbar, const std::wstring& selected) {
  RECT mainBounds{}, toolbarBounds{};
  if(!guardBounds(main,mainBounds)) return false;
  const bool checkToolbar=guardBounds(toolbar,toolbarBounds);
  bool foundMain=false,foundToolbar=!checkToolbar,mainCovered=false,toolbarCovered=false;
  HWND cursor=GetTopWindow(nullptr);
  for(int count=0;cursor&&count<1024;count++) {
    HWND next=GetWindow(cursor,GW_HWNDNEXT);
    if(cursor==main) foundMain=true;
    else if(cursor==toolbar) foundToolbar=true;
    else if(IsWindowVisible(cursor)&&!IsIconic(cursor)) {
      bool owned=false; HWND owner=GetWindow(cursor,GW_OWNER);
      for(int depth=0;owner&&depth<16;depth++,owner=GetWindow(owner,GW_OWNER))
        if(owner==main||owner==toolbar) { owned=true; break; }
      RECT bounds{},overlap{}; DWORD cloaked=0;
      const bool onDesktop=FAILED(DwmGetWindowAttribute(cursor,DWMWA_CLOAKED,&cloaked,sizeof(cloaked)))||!cloaked;
      if(!owned&&onDesktop&&GetWindowRect(cursor,&bounds)) {
        const bool coversMain=!foundMain&&IntersectRect(&overlap,&bounds,&mainBounds);
        const bool coversToolbar=checkToolbar&&!foundToolbar&&IntersectRect(&overlap,&bounds,&toolbarBounds);
        if((coversMain||coversToolbar)&&guardPlatform(cursor,selected)) {
          mainCovered|=coversMain; toolbarCovered|=coversToolbar;
        }
      }
    }
    if(foundMain&&foundToolbar) break;
    cursor=next;
  }
  // A window on a different input desktop must not trigger blind restacking.
  return (foundMain&&mainCovered)||(foundToolbar&&toolbarCovered);
}
