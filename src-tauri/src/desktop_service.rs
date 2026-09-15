use serde::Serialize;
use std::{fs, net::TcpListener, path::PathBuf, process::{Child,Command,Stdio}, sync::Mutex};
use tauri::Manager;
#[derive(Serialize,Clone)]
pub struct Connection { url:String, token:String }
pub struct Service { child:Mutex<Option<Child>>, url:String, data:PathBuf }
impl Service { pub fn stop(&self){if let Ok(mut child)=self.child.lock(){if let Some(mut child)=child.take(){let _=child.kill();let _=child.wait();}}} }
impl Drop for Service { fn drop(&mut self){if let Ok(child)=self.child.get_mut(){if let Some(mut child)=child.take(){let _=child.kill();let _=child.wait();}}} }
pub fn start(app:&tauri::App) -> Result<(),Box<dyn std::error::Error>> {
    let resources=app.path().resource_dir()?.join("resources");
    let data=if let Some(dir)=std::env::var_os("RADAR_DESKTOP_DATA_DIR"){PathBuf::from(dir)}else{PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA missing")?).join("BalanceRadar/data")};
    fs::create_dir_all(&data)?;
    if let Ok(client)=reqwest::blocking::Client::builder().timeout(std::time::Duration::from_millis(500)).build() {
        if let Ok(token)=fs::read_to_string(data.join("access-token")) {
            if let Ok(response)=client.get("http://127.0.0.1:8789/api/auth/status").bearer_auth(token.trim()).send() {
                if response.status().is_success() {
                    if let Ok(body)=response.json::<serde_json::Value>() {
                        if body["mode"]=="local" && body["syncProtocol"]==1 {
                            app.manage(Service{child:Mutex::new(None),url:"http://127.0.0.1:8789".into(),data});
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    let listener=TcpListener::bind("127.0.0.1:0")?;let port=listener.local_addr()?.port();drop(listener);
    let node=resources.join("node.exe");
    let log=fs::OpenOptions::new().create(true).append(true).open(data.join("service.log"))?;
    let mut command=Command::new(node);
    // Node's Windows entrypoint resolver rejects verbatim paths returned by Tauri.
    command.arg("server/index.mjs").current_dir(&resources)
        .env("HOST","127.0.0.1").env("PORT",port.to_string()).env("DATA_DIR",&data).env("RADAR_MODE","local")
        .env("RADAR_PARENT_PID",std::process::id().to_string())
        .env_remove("RADAR_ACCESS_TOKEN").env_remove("RADAR_VAULT_KEY")
        .stdout(Stdio::from(log.try_clone()?)).stderr(Stdio::from(log)).stdin(Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let child=command.spawn()?;
    app.manage(Service{child:Mutex::new(Some(child)),url:format!("http://127.0.0.1:{port}"),data});
    Ok(())
}
#[tauri::command]
pub async fn radar_connection(service:tauri::State<'_,Service>)->Result<Connection,String>{
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(1)).build().map_err(|e|e.to_string())?;
    for _ in 0..60 {
        if let Ok(mut child)=service.child.lock(){if let Some(child)=child.as_mut(){if let Ok(Some(_))=child.try_wait(){return Err("本机服务启动失败，请检查数据目录与安装包完整性".into())}}}
        if let Ok(r)=client.get(format!("{}/api/health",service.url)).send().await {
            if r.status().is_success(){if let Ok(token)=fs::read_to_string(service.data.join("access-token")){return Ok(Connection{url:service.url.clone(),token:token.trim().into()})}}
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Err("本机服务启动超时，请重新打开桌面版".into())
}
