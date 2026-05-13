mod chat;
mod commands;
mod env_config;
mod tests_branch;
mod tests_files;
mod worktrees;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::check_local_repo,
      commands::clone_repo,
      commands::check_git_installed,
      commands::start_device_flow,
      commands::poll_for_token,
      tests_branch::check_tests_branch,
      tests_branch::checkout_tests_branch,
      tests_branch::bootstrap_tests_branch,
      tests_branch::update_scaffold,
      worktrees::create_env_worktree,
      worktrees::remove_env_worktree,
      worktrees::list_worktrees,
      worktrees::detect_project_type,
      worktrees::reveal_in_folder,
      env_config::read_env_config,
      env_config::write_env_config,
      tests_files::list_test_files,
      tests_files::read_test_file,
      chat::chat_available,
      chat::chat_send,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
