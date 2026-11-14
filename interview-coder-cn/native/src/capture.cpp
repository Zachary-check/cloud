#define UNICODE
#define _UNICODE
#ifndef WINVER
#define WINVER 0x0601
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include "background.h"

// This helper owns no credentials, never connects to the network, and returns
// frame pixels through a caller-owned temporary file rather than stdout.
namespace {
constexpr size_t MAX_PIXELS = 33554432;
struct Image { RECT rect{}; int width=0, height=0; std::vector<uint8_t> pixels; };
struct Window {
  HWND hwnd{}; DWORD pid=0; RECT rect{}, client{};
  std::wstring process, className;
  bool foreground=false, fullscreen=false, protectedCapture=false;
};
struct Options {
  std::wstring command=L"capture", mode=L"gdi", platform=L"general", output;
  DWORD ownerPid=0; std::wstring display=L"primary";
};
template<typename T> void release(T*& pointer) { if(pointer) { pointer->Release(); pointer=nullptr; } }
std::string utf8(const std::wstring& value) {
  if(value.empty()) return {};
  int length=WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);
  std::string result(length,'\0');
  WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),result.data(),length,nullptr,nullptr);
  return result;
}
std::string json(const std::string& value) {
  std::ostringstream out; out << '"';
  const char* hex="0123456789abcdef";
  for(unsigned char ch:value) {
    if(ch=='"'||ch=='\\') out << '\\' << ch;
    else if(ch<32) out << "\\u00" << hex[ch>>4] << hex[ch&15];
    else out << ch;
  }
  out << '"'; return out.str();
}
bool dimensions(Image& image, RECT rect, std::string& error) {
  const int64_t width=static_cast<int64_t>(rect.right)-rect.left;
  const int64_t height=static_cast<int64_t>(rect.bottom)-rect.top;
  if(width<1||height<1||width>32768||height>32768||width*height>MAX_PIXELS) {
    error="Unsupported frame dimensions"; return false;
  }
  image.rect=rect; image.width=static_cast<int>(width); image.height=static_cast<int>(height);
  image.pixels.resize(static_cast<size_t>(width*height)*4); return true;
}
void opaque(Image& image) { for(size_t i=3;i<image.pixels.size();i+=4) image.pixels[i]=255; }
bool dark(const Image& image) {
  if(image.pixels.empty()) return true;
  size_t count=0, black=0;
  const int step=std::max(1,std::max(image.width,image.height)/320);
  for(int y=0;y<image.height;y+=step) for(int x=0;x<image.width;x+=step) {
    const size_t i=(static_cast<size_t>(y)*image.width+x)*4; count++;
    if(image.pixels[i]<12&&image.pixels[i+1]<12&&image.pixels[i+2]<12) black++;
  }
  return count==0||static_cast<double>(black)/count>=0.995;
}
void composite(Image& target,const Image& source) {
  RECT overlap{}; if(!IntersectRect(&overlap,&target.rect,&source.rect)) return;
  const size_t rowBytes=static_cast<size_t>(overlap.right-overlap.left)*4;
  for(LONG y=overlap.top;y<overlap.bottom;y++) {
    size_t dst=(static_cast<size_t>(y-target.rect.top)*target.width+overlap.left-target.rect.left)*4;
    size_t src=(static_cast<size_t>(y-source.rect.top)*source.width+overlap.left-source.rect.left)*4;
    memcpy(target.pixels.data()+dst,source.pixels.data()+src,rowBytes);
  }
}
bool bitmapCapture(RECT rect, HWND window, Image& image,std::string& error) {
  if(!dimensions(image,rect,error)) return false;
  HDC screen=GetDC(nullptr); if(!screen) { error="GetDC failed"; return false; }
  HDC memory=CreateCompatibleDC(screen);
  BITMAPINFO info{}; info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth=image.width; info.bmiHeader.biHeight=-image.height;
  info.bmiHeader.biPlanes=1; info.bmiHeader.biBitCount=32; info.bmiHeader.biCompression=BI_RGB;
  void* pixels=nullptr;
  HBITMAP bitmap=memory?CreateDIBSection(screen,&info,DIB_RGB_COLORS,&pixels,nullptr,0):nullptr;
  if(!bitmap) { if(memory) DeleteDC(memory); ReleaseDC(nullptr,screen); error="CreateDIBSection failed"; return false; }
  HGDIOBJ previous=SelectObject(memory,bitmap); memset(pixels,0,image.pixels.size());
  // Protected targets have their own reconstruction routes. Including every
  // layered overlay here forces extra desktop composition on each screenshot.
  BOOL ok=window?PrintWindow(window,memory,3):BitBlt(memory,0,0,image.width,image.height,screen,rect.left,rect.top,SRCCOPY);
  GdiFlush();
  if(ok) memcpy(image.pixels.data(),pixels,image.pixels.size());
  SelectObject(memory,previous); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(nullptr,screen);
  if(!ok) { error=window?"PrintWindow failed":"BitBlt failed"; return false; }
  opaque(image); return true;
}
using SharedSurfaceFunction=BOOL(WINAPI*)(HWND,HANDLE*,LUID*,ULONG*,ULONG*,ULONGLONG*);
SharedSurfaceFunction sharedSurfaceFunction() {
  return reinterpret_cast<SharedSurfaceFunction>(GetProcAddress(GetModuleHandleW(L"user32.dll"),"DwmGetDxSharedSurface"));
}
bool sharedCapture(const Window& window,Image& image,std::string& error) {
  auto getSurface=sharedSurfaceFunction();
  if(!getSurface) { error="Shared surface export unavailable"; return false; }
  HANDLE surface=nullptr; LUID luid{}; ULONG format=0,flags=0; ULONGLONG monitor=0;
  if(!getSurface(window.hwnd,&surface,&luid,&format,&flags,&monitor)||!surface||surface==INVALID_HANDLE_VALUE) {
    error="Window has no readable shared surface"; return false;
  }
  IDXGIFactory1* factory=nullptr; IDXGIAdapter1* adapter=nullptr;
  ID3D11Device* device=nullptr; ID3D11DeviceContext* context=nullptr;
  ID3D11Texture2D* texture=nullptr; ID3D11Texture2D* staging=nullptr;
  bool success=false;
  do {
    HRESULT hr=CreateDXGIFactory1(__uuidof(IDXGIFactory1),reinterpret_cast<void**>(&factory));
    if(FAILED(hr)) { error="CreateDXGIFactory1 failed"; break; }
    for(UINT index=0;;index++) {
      IDXGIAdapter1* candidate=nullptr;
      if(factory->EnumAdapters1(index,&candidate)==DXGI_ERROR_NOT_FOUND) break;
      if(!candidate) break;
      DXGI_ADAPTER_DESC1 desc{}; candidate->GetDesc1(&desc);
      if(desc.AdapterLuid.HighPart==luid.HighPart&&desc.AdapterLuid.LowPart==luid.LowPart) { adapter=candidate; break; }
      candidate->Release();
    }
    if(!adapter) { error="Shared surface adapter unavailable"; break; }
    hr=D3D11CreateDevice(adapter,D3D_DRIVER_TYPE_UNKNOWN,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context);
    if(FAILED(hr)) { error="D3D11CreateDevice failed"; break; }
    hr=device->OpenSharedResource(surface,__uuidof(ID3D11Texture2D),reinterpret_cast<void**>(&texture));
    if(FAILED(hr)) { error="OpenSharedResource failed"; break; }
    D3D11_TEXTURE2D_DESC desc{}; texture->GetDesc(&desc);
    const bool rgba=desc.Format==DXGI_FORMAT_R8G8B8A8_UNORM||desc.Format==DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
    const bool bgra=desc.Format==DXGI_FORMAT_B8G8R8A8_UNORM||desc.Format==DXGI_FORMAT_B8G8R8A8_UNORM_SRGB||desc.Format==DXGI_FORMAT_B8G8R8X8_UNORM;
    if((!rgba&&!bgra)||desc.SampleDesc.Count!=1||desc.ArraySize!=1) { error="Unsupported shared surface format"; break; }
    RECT origin{};
    if(desc.Width==static_cast<UINT>(window.rect.right-window.rect.left)&&desc.Height==static_cast<UINT>(window.rect.bottom-window.rect.top)) origin=window.rect;
    else if(desc.Width==static_cast<UINT>(window.client.right-window.client.left)&&desc.Height==static_cast<UINT>(window.client.bottom-window.client.top)) origin=window.client;
    else { error="Unsupported shared surface layout"; break; }
    if(!dimensions(image,origin,error)) break;
    desc.MipLevels=1; desc.ArraySize=1; desc.Usage=D3D11_USAGE_STAGING;
    desc.BindFlags=0; desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ; desc.MiscFlags=0;
    hr=device->CreateTexture2D(&desc,nullptr,&staging);
    if(FAILED(hr)) { error="Create staging texture failed"; break; }
    context->CopySubresourceRegion(staging,0,0,0,0,texture,0,nullptr);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    hr=context->Map(staging,0,D3D11_MAP_READ,0,&mapped);
    if(FAILED(hr)) { error="Map shared surface failed"; break; }
    if(mapped.RowPitch<static_cast<UINT>(image.width*4)) { context->Unmap(staging,0); error="Invalid shared surface stride"; break; }
    for(int y=0;y<image.height;y++) {
      auto* row=static_cast<uint8_t*>(mapped.pData)+static_cast<size_t>(y)*mapped.RowPitch;
      memcpy(image.pixels.data()+static_cast<size_t>(y)*image.width*4,row,static_cast<size_t>(image.width)*4);
    }
    context->Unmap(staging,0);
    if(rgba) for(size_t i=0;i<image.pixels.size();i+=4) std::swap(image.pixels[i],image.pixels[i+2]);
    opaque(image); success=true;
  } while(false);
  release(staging); release(texture); release(context); release(device); release(adapter); release(factory);
  return success;
}
std::wstring processName(DWORD pid) {
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
  if(!process) return {};
  wchar_t buffer[32768]; DWORD length=32768;
  BOOL ok=QueryFullProcessImageNameW(process,0,buffer,&length); CloseHandle(process);
  if(!ok) return {};
  std::wstring result(buffer,length); const auto slash=result.find_last_of(L"\\/");
  if(slash!=std::wstring::npos) result=result.substr(slash+1);
  std::transform(result.begin(),result.end(),result.begin(),towlower); return result;
}
#include "window-order.h"
bool windowInfo(HWND hwnd,Window& window,DWORD ownerPid) {
  if(!IsWindowVisible(hwnd)||IsIconic(hwnd)||hwnd==GetShellWindow()) return false;
  DWORD cloaked=0;
  if(SUCCEEDED(DwmGetWindowAttribute(hwnd,DWMWA_CLOAKED,&cloaked,sizeof(cloaked)))&&cloaked) return false;
  GetWindowThreadProcessId(hwnd,&window.pid);
  if(window.pid==GetCurrentProcessId()||window.pid==ownerPid) return false;
  window.hwnd=hwnd;
  if(!GetWindowRect(hwnd,&window.rect)) return false;
  RECT client{}; if(!GetClientRect(hwnd,&client)) return false;
  POINT start{client.left,client.top},end{client.right,client.bottom};
  if(!ClientToScreen(hwnd,&start)||!ClientToScreen(hwnd,&end)) return false;
  window.client={start.x,start.y,end.x,end.y};
  if(client.right-client.left<2||client.bottom-client.top<2) return false;
  window.process=processName(window.pid); window.foreground=hwnd==GetForegroundWindow();
  DWORD affinity=0; window.protectedCapture=GetWindowDisplayAffinity(hwnd,&affinity)&&affinity!=0;
  wchar_t name[256]{}; GetClassNameW(hwnd,name,256); window.className=name;
  if(window.className==L"IntegratedNativeAnswer") return false;
  MONITORINFO monitor{}; monitor.cbSize=sizeof(monitor);
  if(GetMonitorInfoW(MonitorFromWindow(hwnd,MONITOR_DEFAULTTONEAREST),&monitor)) {
    const RECT r=monitor.rcMonitor;
    window.fullscreen=abs(window.rect.left-r.left)<=2&&abs(window.rect.top-r.top)<=2&&
      abs(window.rect.right-r.right)<=2&&abs(window.rect.bottom-r.bottom)<=2;
  }
  return true;
}
struct WindowCollection { std::vector<Window> windows; DWORD ownerPid; };
BOOL CALLBACK enumerate(HWND hwnd,LPARAM parameter) {
  auto& collection=*reinterpret_cast<WindowCollection*>(parameter); Window window;
  if(collection.windows.size()<128&&windowInfo(hwnd,window,collection.ownerPid)) collection.windows.push_back(std::move(window));
  return TRUE;
}
std::vector<Window> windows(DWORD ownerPid) {
  WindowCollection collection{{},ownerPid}; EnumWindows(enumerate,reinterpret_cast<LPARAM>(&collection)); return collection.windows;
}
BOOL CALLBACK enumerateChildren(HWND hwnd,LPARAM parameter) {
  auto& result=*reinterpret_cast<std::vector<Window>*>(parameter); Window window;
  if(result.size()<128&&windowInfo(hwnd,window,0)) result.push_back(std::move(window)); return TRUE;
}
bool childCapture(const Window& parent,Image& image,std::string& error) {
  std::vector<Window> children;
  EnumChildWindows(parent.hwnd,enumerateChildren,reinterpret_cast<LPARAM>(&children));
  std::sort(children.begin(),children.end(),[](const Window& a,const Window& b) {
    return static_cast<int64_t>(a.client.right-a.client.left)*(a.client.bottom-a.client.top)>
      static_cast<int64_t>(b.client.right-b.client.left)*(b.client.bottom-b.client.top);
  });
  const int64_t parentArea=static_cast<int64_t>(parent.client.right-parent.client.left)*(parent.client.bottom-parent.client.top);
  for(const auto& child:children) {
    const int64_t area=static_cast<int64_t>(child.client.right-child.client.left)*(child.client.bottom-child.client.top);
    if(area<parentArea/4) continue;
    if(sharedCapture(child,image,error)&&!dark(image)) return true;
    if(bitmapCapture(child.client,child.hwnd,image,error)&&!dark(image)) return true;
  }
  error="No readable child window"; return false;
}
bool matching(const Window& window,const std::wstring& platform) {
  if(window.protectedCapture) return true;
  if(!(window.foreground||window.fullscreen)) return false;
  return (platform==L"shixizhi"&&window.process==L"shixizhiclient.exe")||
    (platform==L"iguokao"&&window.process==L"国考云.exe")||
    (platform==L"eztest"&&window.process==L"eztest.exe");
}
struct Display { RECT rect; std::wstring id; };
BOOL CALLBACK monitors(HMONITOR monitor,HDC,LPRECT,LPARAM parameter) {
  auto& result=*reinterpret_cast<std::vector<Display>*>(parameter);
  MONITORINFOEXW info{}; info.cbSize=sizeof(info);
  if(GetMonitorInfoW(monitor,reinterpret_cast<MONITORINFO*>(&info))) {
    if(info.dwFlags&MONITORINFOF_PRIMARY) result.insert(result.begin(),Display{info.rcMonitor,info.szDevice});
    else result.push_back(Display{info.rcMonitor,info.szDevice});
  }
  return TRUE;
}
std::string snapshot(const std::vector<Window>& items) {
  std::ostringstream out; out << '['; bool first=true;
  for(const auto& item:items) {
    if(!first) out << ','; first=false;
    out << "{\"pid\":" << item.pid << ",\"process\":" << json(utf8(item.process)) <<
      ",\"className\":" << json(utf8(item.className)) << ",\"foreground\":" << (item.foreground?"true":"false") <<
      ",\"fullscreen\":" << (item.fullscreen?"true":"false") << ",\"protected\":" << (item.protectedCapture?"true":"false") << '}';
  }
  out << ']'; return out.str();
}
DWORD windowsBuild() {
  using VersionFunction=LONG(WINAPI*)(OSVERSIONINFOW*);
  auto version=reinterpret_cast<VersionFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlGetVersion"));
  OSVERSIONINFOW info{}; info.dwOSVersionInfoSize=sizeof(info);
  return version&&version(&info)==0?info.dwBuildNumber:0;
}
class InputDesktop {
  HDESK previous=nullptr, current=nullptr; bool attached=false;
public:
  InputDesktop() {
    previous=GetThreadDesktop(GetCurrentThreadId());
    current=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
    if(current) attached=SetThreadDesktop(current)!=FALSE;
  }
  ~InputDesktop() { if(attached&&previous) SetThreadDesktop(previous); if(current) CloseDesktop(current); }
};
Options parse(int argc,wchar_t** argv) {
  Options result;
  for(int i=1;i<argc;i++) {
    const std::wstring key=argv[i];
    if(key==L"--capabilities") result.command=L"capabilities";
    else if(key==L"--snapshot") result.command=L"snapshot";
    else if(key==L"--watch-background") result.command=L"background";
    else if(key==L"--watch-window-order") result.command=L"window-order";
    else if(i+1<argc) {
      const std::wstring value=argv[++i];
      if(key==L"--mode") result.mode=value;
      else if(key==L"--platform") result.platform=value;
      else if(key==L"--output") result.output=value;
      else if(key==L"--owner-pid") result.ownerPid=std::stoul(value);
      else if(key==L"--display") result.display=value;
      else throw std::runtime_error("Unknown option");
    } else throw std::runtime_error("Missing option value");
  }
  return result;
}
int run(const Options& options) {
  using DpiAwarenessFunction=BOOL(WINAPI*)(HANDLE);
  auto awareness=reinterpret_cast<DpiAwarenessFunction>(GetProcAddress(GetModuleHandleW(L"user32.dll"),"SetProcessDpiAwarenessContext"));
  if(!awareness||!awareness(reinterpret_cast<HANDLE>(-4))) SetProcessDPIAware();
  InputDesktop desktop;
  if(options.command==L"window-order") {
    std::string line;
    while(std::getline(std::cin,line)) {
      if(line=="stop") break;
      if(line.size()>160) return 1;
      std::istringstream input(line); uint64_t main=0,toolbar=0; std::string selected,extra;
      if(!(input>>main>>toolbar>>selected)||(input>>extra)) return 1;
      if(selected!="auto"&&selected!="general"&&selected!="iguokao"&&selected!="shixizhi"&&selected!="eztest") return 1;
      const std::wstring platform(selected.begin(),selected.end());
      InputDesktop current;
      const bool covered=platformCoversOverlay(reinterpret_cast<HWND>(main),reinterpret_cast<HWND>(toolbar),platform);
      std::cout << "{\"ok\":true,\"covered\":" << (covered?"true":"false") << "}\n" << std::flush;
    }
    return 0;
  }
  if(options.command==L"background") {
    std::string line; bool light=true;
    while(std::getline(std::cin,line)) {
      if(line=="stop") break;
      if(line.size()>160) return 1;
      std::istringstream input(line); long long x=0,y=0,width=0,height=0;
      if(!(input>>x>>y>>width>>height)||x<-131072||y<-131072||x>131072||y>131072||width<1||height<1||width>32768||height>32768) return 1;
      InputDesktop current;
      const auto sample=sampleBackground({static_cast<LONG>(x),static_cast<LONG>(y),static_cast<LONG>(x+width),static_cast<LONG>(y+height)},light);
      if(sample.ok) light=sample.light;
      std::cout << "{\"ok\":" << (sample.ok?"true":"false") << ",\"theme\":\"" << (light?"light":"dark") << "\"}\n" << std::flush;
    }
    return 0;
  }
  std::vector<Display> displays; EnumDisplayMonitors(nullptr,nullptr,monitors,reinterpret_cast<LPARAM>(&displays));
  if(options.command==L"capabilities") {
    std::cout << "{\"ok\":true,\"protocol\":1,\"windowsBuild\":" << windowsBuild() <<
      ",\"methods\":[\"gdi\",\"printWindow\",\"gpuChild\"" << (sharedSurfaceFunction()?",\"sharedSurface\"":"") << "],\"displays\":[";
    for(size_t i=0;i<displays.size();i++) {
      if(i) std::cout << ',';
      const auto& d=displays[i];
      std::cout << "{\"id\":" << json(utf8(d.id)) << ",\"name\":" << json("Screen "+std::to_string(i+1)) <<
        ",\"width\":" << d.rect.right-d.rect.left << ",\"height\":" << d.rect.bottom-d.rect.top << '}';
    }
    std::cout << "]}\n";
    return 0;
  }
  const auto items=windows(options.ownerPid);
  if(options.command==L"snapshot") { std::cout << "{\"ok\":true,\"windows\":" << snapshot(items) << "}\n"; return 0; }
  if(options.output.empty()) throw std::runtime_error("Output file is required");
  if(options.mode!=L"gdi"&&options.mode!=L"sharedSurface"&&options.mode!=L"gpuChild"&&options.mode!=L"printWindow") throw std::runtime_error("Unknown capture mode");
  if(displays.empty()) throw std::runtime_error("No display is available");
  size_t display=0;
  if(options.display!=L"primary") {
    auto found=std::find_if(displays.begin(),displays.end(),[&](const Display& item){ return item.id==options.display; });
    if(found==displays.end()) throw std::runtime_error("Selected display is disconnected");
    display=static_cast<size_t>(found-displays.begin());
  }
  Image image; std::string error;
  if(!bitmapCapture(displays[display].rect,nullptr,image,error)) throw std::runtime_error(error);
  int candidates=0,reconstructed=0; std::vector<std::string> errors;
  if(options.mode!=L"gdi") for(auto it=items.rbegin();it!=items.rend();++it) {
    RECT overlap{}; if(!matching(*it,options.platform)||!IntersectRect(&overlap,&image.rect,&it->client)) continue;
    candidates++; Image replacement; bool ok=false;
    if(options.mode==L"sharedSurface") ok=sharedCapture(*it,replacement,error);
    else if(options.mode==L"gpuChild") ok=childCapture(*it,replacement,error);
    else ok=bitmapCapture(it->client,it->hwnd,replacement,error);
    if(ok&&!dark(replacement)) { composite(image,replacement); reconstructed++; }
    else if(errors.size()<16) errors.push_back(error.empty()?"Candidate image was blank":error);
  }
  HANDLE output=CreateFileW(options.output.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_TEMPORARY,nullptr);
  if(output==INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create private frame output");
  DWORD written=0; BOOL ok=WriteFile(output,image.pixels.data(),static_cast<DWORD>(image.pixels.size()),&written,nullptr);
  CloseHandle(output);
  if(!ok||written!=image.pixels.size()) { DeleteFileW(options.output.c_str()); throw std::runtime_error("Could not write complete frame"); }
  std::cout << "{\"ok\":true,\"width\":" << image.width << ",\"height\":" << image.height <<
    ",\"stride\":" << image.width*4 << ",\"left\":" << image.rect.left << ",\"top\":" << image.rect.top <<
    ",\"method\":" << json(utf8(options.mode)) << ",\"candidates\":" << candidates <<
    ",\"reconstructed\":" << reconstructed << ",\"windows\":" << snapshot(items) << ",\"errors\":[";
  for(size_t i=0;i<errors.size();i++) { if(i) std::cout << ','; std::cout << json(errors[i]); }
  std::cout << "]}\n"; return 0;
}
}
int wmain(int argc,wchar_t** argv) {
  try { return run(parse(argc,argv)); }
  catch(const std::exception& error) { std::cout << "{\"ok\":false,\"error\":" << json(error.what()) << "}\n"; return 1; }
}
