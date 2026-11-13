#define UNICODE
#define _UNICODE
#include <windows.h>
#include <algorithm>
#include <iostream>
#include <string>
#include <thread>
#include <mutex>
#include "background.h"

namespace {
constexpr UINT UPDATE_STATE=WM_APP+1, EXIT_WINDOW=WM_APP+3;
HWND window=nullptr;
DWORD guiThread=0;
std::wstring answer, status=L"原生答题窗 · 正在等待截题";
std::wstring desktopName;
HDESK attachedDesktop=nullptr;
HFONT font=nullptr, smallFont=nullptr;
bool running=true, rebuilding=false, folded=false, textOnly=true, lightBackground=true;
constexpr COLORREF TRANSPARENT_COLOR=RGB(1,2,3);
std::mutex updatesMutex;
struct PendingUpdates {
  std::wstring text,status,appearance;
  bool hasText=false,hasStatus=false,hasAppearance=false,notified=false;
} updates;
int scrollOffset=0, hoverIndex=-1, hoverMs=1200;
ULONGLONG hoverSince=0;
const wchar_t* labels[]={L"截题",L"加页",L"复制",L"停止",L"上翻",L"下翻",L"收起",L"退出"};
const char* actions[]={"capture","append","copy","stop","up","down","fold","exit"};

std::wstring decode(const std::string& text) {
  static const std::string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string bytes; int bits=0, value=0;
  for(unsigned char ch:text) {
    if(ch=='=') break;
    const size_t index=alphabet.find(ch); if(index==std::string::npos) continue;
    value=(value<<6)|static_cast<int>(index); bits+=6;
    if(bits>=8) { bits-=8; bytes.push_back(static_cast<char>((value>>bits)&255)); value&=(1<<bits)-1; }
    if(bytes.size()>256000) break;
  }
  if(bytes.empty()) return {};
  const int count=MultiByteToWideChar(CP_UTF8,0,bytes.data(),static_cast<int>(bytes.size()),nullptr,0);
  std::wstring result(count,L'\0');
  MultiByteToWideChar(CP_UTF8,0,bytes.data(),static_cast<int>(bytes.size()),result.data(),count);
  return result;
}
void emit(const char* event) { std::cout << "{\"event\":\"" << event << "\"}\n" << std::flush; }
void action(int index) {
  if(index==4) scrollOffset=std::max(0,scrollOffset-200);
  else if(index==5) scrollOffset+=200;
  else if(index==6) { folded=!folded; SetWindowPos(window,HWND_TOPMOST,0,0,640,folded?88:460,SWP_NOMOVE|SWP_NOACTIVATE); }
  else if(index==7) PostMessageW(window,WM_CLOSE,0,0);
  else { status=index<2?L"正在截取题目…":status; emit(actions[index]); }
  InvalidateRect(window,nullptr,FALSE);
}
std::wstring inputDesktopName(HDESK desktop) {
  wchar_t name[256]{}; DWORD bytes=sizeof(name);
  return desktop&&GetUserObjectInformationW(desktop,UOI_NAME,name,bytes,&bytes)?name:L"";
}
void paint(HWND hwnd) {
  PAINTSTRUCT paint{}; HDC dc=BeginPaint(hwnd,&paint); RECT client{}; GetClientRect(hwnd,&client);
  const COLORREF foreground=textOnly&&lightBackground?RGB(24,24,27):RGB(245,245,245);
  HBRUSH background=CreateSolidBrush(textOnly?TRANSPARENT_COLOR:RGB(23,28,38)); FillRect(dc,&client,background); DeleteObject(background);
  SetBkMode(dc,TRANSPARENT); SetTextColor(dc,foreground); SelectObject(dc,smallFont);
  for(int i=0;i<8;i++) {
    RECT rect{8+i*78,8,80+i*78,40};
    if(!textOnly||i==hoverIndex) {
      HBRUSH brush=CreateSolidBrush(textOnly?(lightBackground?RGB(225,228,235):RGB(57,79,115)):i==hoverIndex?RGB(57,79,115):RGB(39,48,66));
      FillRect(dc,&rect,brush); DeleteObject(brush);
    }
    DrawTextW(dc,labels[i],-1,&rect,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
  }
  RECT caption{12,48,client.right-12,80}; SetTextColor(dc,textOnly?foreground:RGB(160,180,210));
  DrawTextW(dc,status.c_str(),static_cast<int>(status.size()),&caption,DT_SINGLELINE|DT_END_ELLIPSIS);
  if(!folded) {
    SelectObject(dc,font); SetTextColor(dc,foreground);
    RECT measured{16,0,std::max(32L,client.right-16),0};
    DrawTextW(dc,answer.c_str(),static_cast<int>(answer.size()),&measured,DT_WORDBREAK|DT_CALCRECT|DT_NOPREFIX);
    scrollOffset=std::clamp(scrollOffset,0,std::max(0,static_cast<int>(measured.bottom-client.bottom+92)));
    IntersectClipRect(dc,12,88,client.right-12,client.bottom-8);
    RECT body{16,88-scrollOffset,client.right-16,88-scrollOffset+measured.bottom};
    DrawTextW(dc,answer.c_str(),static_cast<int>(answer.size()),&body,DT_WORDBREAK|DT_NOPREFIX);
  }
  EndPaint(hwnd,&paint);
}
LRESULT CALLBACK procedure(HWND hwnd,UINT message,WPARAM wParam,LPARAM lParam) {
  switch(message) {
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: paint(hwnd); return 0;
    case WM_MOUSEWHEEL: scrollOffset=std::max(0,scrollOffset-GET_WHEEL_DELTA_WPARAM(wParam)); InvalidateRect(hwnd,nullptr,FALSE); return 0;
    case WM_LBUTTONUP: {
      POINT point{static_cast<short>(LOWORD(lParam)),static_cast<short>(HIWORD(lParam))};
      if(point.y>=8&&point.y<40&&point.x>=8) { int index=(point.x-8)/78; if(index<8) action(index); }
      return 0;
    }
    case WM_NCHITTEST: {
      POINT point{static_cast<short>(LOWORD(lParam)),static_cast<short>(HIWORD(lParam))}; ScreenToClient(hwnd,&point);
      if(point.y>=42&&point.y<85) return HTCAPTION;
      return HTCLIENT;
    }
    case WM_CLOSE: running=false; DestroyWindow(hwnd); return 0;
    case WM_DESTROY: if(!rebuilding) running=false; return 0;
  }
  return DefWindowProcW(hwnd,message,wParam,lParam);
}
bool createWindow(HINSTANCE instance,RECT previous={}) {
  WNDCLASSW cls{}; cls.lpfnWndProc=procedure; cls.hInstance=instance; cls.lpszClassName=L"IntegratedNativeAnswer";
  cls.hCursor=LoadCursorW(nullptr,IDC_ARROW); RegisterClassW(&cls);
  int x=previous.right?previous.left:std::max(0,GetSystemMetrics(SM_CXSCREEN)-660);
  int y=previous.bottom?previous.top:80;
  window=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_LAYERED,cls.lpszClassName,L"解题助手原生答题窗",WS_POPUP,
    x,y,640,folded?88:460,nullptr,nullptr,instance,nullptr);
  if(!window) return false;
  SetLayeredWindowAttributes(window,TRANSPARENT_COLOR,textOnly?255:235,textOnly?LWA_COLORKEY:LWA_ALPHA);
  SetWindowDisplayAffinity(window,0x11);
  // A hidden console startup can override the first ShowWindow call. Explicitly
  // show our GUI window without activating it, independently of console flags.
  ShowWindow(window,SW_SHOWNOACTIVATE); SetWindowPos(window,HWND_TOPMOST,0,0,0,0,SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_SHOWWINDOW);
  return true;
}
void followDesktop(HINSTANCE instance) {
  HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS|DESKTOP_CREATEWINDOW|DESKTOP_WRITEOBJECTS);
  const auto name=inputDesktopName(input);
  if(!input||name.empty()||name==desktopName) { if(input) CloseDesktop(input); return; }
  RECT bounds{}; if(window) GetWindowRect(window,&bounds);
  rebuilding=true; if(window) DestroyWindow(window); window=nullptr;
  if(SetThreadDesktop(input)) {
    if(attachedDesktop) CloseDesktop(attachedDesktop);
    attachedDesktop=input; desktopName=name; input=nullptr;
    if(!createWindow(instance,bounds)) running=false;
  } else if(!createWindow(instance,bounds)) running=false;
  rebuilding=false; if(input) CloseDesktop(input);
}
}
int wmain(int argc,wchar_t** argv) {
  if(argc>2&&std::wstring(argv[1])==L"--hover-ms") {
    const int requested=_wtoi(argv[2]); hoverMs=requested<=0?0:std::clamp(requested,300,6000);
  }
  SetProcessDPIAware(); guiThread=GetCurrentThreadId(); MSG message{}; PeekMessageW(&message,nullptr,WM_USER,WM_USER,PM_NOREMOVE);
  HINSTANCE instance=GetModuleHandleW(nullptr);
  desktopName=inputDesktopName(GetThreadDesktop(guiThread));
  font=CreateFontW(-18,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,ANTIALIASED_QUALITY,0,L"Microsoft YaHei UI");
  smallFont=CreateFontW(-14,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,ANTIALIASED_QUALITY,0,L"Microsoft YaHei UI");
  followDesktop(instance);
  if(!window&&!createWindow(instance)) { emit("error"); return 1; }
  std::thread([] {
    std::string line;
    while(std::getline(std::cin,line)) {
      if(line=="stop") break;
      if(line.size()>400000) break;
      const auto separator=line.find(' '); if(separator==std::string::npos) continue;
      const auto kind=line.substr(0,separator);
      if(kind=="text"||kind=="status"||kind=="appearance") {
        auto text=decode(line.substr(separator+1));
        std::lock_guard<std::mutex> lock(updatesMutex);
        if(kind=="text") { updates.text=std::move(text); updates.hasText=true; }
        else if(kind=="status") { updates.status=std::move(text); updates.hasStatus=true; }
        else { updates.appearance=std::move(text); updates.hasAppearance=true; }
        // Keep only the latest state if painting cannot keep up with streaming.
        if(!updates.notified) updates.notified=PostThreadMessageW(guiThread,UPDATE_STATE,0,0)!=FALSE;
      }
    }
    PostThreadMessageW(guiThread,EXIT_WINDOW,0,0);
  }).detach();
  emit("ready");
  ULONGLONG checked=0, backgroundChecked=0;
  while(running) {
    while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
      if(message.message==UPDATE_STATE) {
        PendingUpdates next;
        { std::lock_guard<std::mutex> lock(updatesMutex); std::swap(next,updates); }
        if(next.hasText) { answer=std::move(next.text); if(answer.empty()) scrollOffset=0; }
        if(next.hasStatus) status=std::move(next.status);
        if(next.hasAppearance) {
          textOnly=next.appearance==L"text";
          if(window) SetLayeredWindowAttributes(window,TRANSPARENT_COLOR,textOnly?255:235,textOnly?LWA_COLORKEY:LWA_ALPHA);
          backgroundChecked=0;
        }
        if(window) InvalidateRect(window,nullptr,FALSE);
      } else if(message.message==EXIT_WINDOW) running=false;
      else { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    const auto now=GetTickCount64();
    if(now-checked>=500) { checked=now; followDesktop(instance); if(window) SetWindowPos(window,HWND_TOPMOST,0,0,0,0,SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE); }
    if(window) {
      if(textOnly&&now-backgroundChecked>=1200) {
        backgroundChecked=now; RECT bounds{}; GetWindowRect(window,&bounds); bounds.top+=88;
        const auto sample=sampleBackground(bounds,lightBackground);
        if(sample.ok&&sample.light!=lightBackground) { lightBackground=sample.light; InvalidateRect(window,nullptr,FALSE); }
      }
      POINT cursor{}; GetCursorPos(&cursor); ScreenToClient(window,&cursor);
      int hovered=cursor.y>=8&&cursor.y<40&&cursor.x>=8&&cursor.x<632?(cursor.x-8)/78:-1;
      if(hovered!=hoverIndex) { hoverIndex=hovered; hoverSince=now; InvalidateRect(window,nullptr,FALSE); }
      if(hoverMs>0&&hoverIndex>=0&&hoverSince&&now-hoverSince>=static_cast<ULONGLONG>(hoverMs)) { action(hoverIndex); hoverSince=0; }
    }
    MsgWaitForMultipleObjects(0,nullptr,FALSE,50,QS_ALLINPUT);
  }
  emit("exit"); if(window&&IsWindow(window)) DestroyWindow(window);
  DeleteObject(font); DeleteObject(smallFont);
  // Windows releases the desktop handle after the last GUI thread exits.
  return 0;
}
