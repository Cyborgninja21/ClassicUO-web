// SPDX-License-Identifier: BSD-2-Clause

using System;
using System.IO;
using ClassicUO.Utility;
using Microsoft.Xna.Framework;

namespace ClassicUO.Configuration
{
    internal static class ProfileManager
    {
        public static GlobalProfile GlobalProfile { get; private set; }
        public static Profile CurrentProfile { get; private set; }
        public static string ProfilePath { get; private set; }

        private static string _rootPath;
        private static string RootPath
        {
            get
            {
                if (string.IsNullOrEmpty(_rootPath))
                {
                    if (string.IsNullOrWhiteSpace(Settings.GlobalSettings.ProfilesPath))
                    {
                        _rootPath = Path.Combine(CUOEnviroment.ExecutablePath, "Data", "Profiles");
                    }
                    else
                    {
                        _rootPath = Settings.GlobalSettings.ProfilesPath;
                    }
                }

                return _rootPath;
            }
        }

        public static void Load(string servername, string username, string charactername)
        {
            // Be tolerant of a MEMFS folder/JSON hiccup here: if any step throws, the
            // world Views deref CurrentProfile unguarded and NRE the whole game scene.
            // Always leave CurrentProfile set (a fresh default at worst).
            try
            {
                GlobalProfile = ConfigurationResolver.Load<GlobalProfile>(Path.Combine(RootPath, "globalprofile.json"), ProfileJsonContext.DefaultToUse.GlobalProfile) ?? new GlobalProfile();

                string path = FileSystemHelper.CreateFolderIfNotExists(RootPath, username, servername, charactername);
                ProfilePath = path;
                CurrentProfile = ConfigurationResolver.Load<Profile>(Path.Combine(path, "profile.json"), ProfileJsonContext.DefaultToUse.Profile) ?? NewFromDefault();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[ProfileManager] Load failed, using a default profile: " + ex);
                GlobalProfile ??= new GlobalProfile();
                CurrentProfile = new Profile();
            }

            CurrentProfile ??= new Profile();
            CurrentProfile.Username = string.IsNullOrEmpty(username) ? "player" : username;
            CurrentProfile.ServerName = string.IsNullOrEmpty(servername) ? "_" : servername;
            CurrentProfile.CharacterName = string.IsNullOrEmpty(charactername) ? "char" : charactername;

            ValidateFields(CurrentProfile);
        }

        public static void SetProfileAsDefault(Profile profile)
        {
            Save(profile, RootPath, "default.json");
        }

        public static Profile NewFromDefault()
        {
            return ConfigurationResolver.Load<Profile>(Path.Combine(RootPath, "default.json"), ProfileJsonContext.DefaultToUse.Profile) ?? new Profile();
        }

        private static void ValidateFields(Profile profile)
        {
            if (profile == null)
            {
                return;
            }

            if (string.IsNullOrEmpty(profile.ServerName))
            {
                throw new InvalidDataException();
            }

            if (string.IsNullOrEmpty(profile.Username))
            {
                throw new InvalidDataException();
            }

            if (string.IsNullOrEmpty(profile.CharacterName))
            {
                throw new InvalidDataException();
            }

            if (profile.WindowClientBounds.X < 600)
            {
                profile.WindowClientBounds = new Point(600, profile.WindowClientBounds.Y);
            }

            if (profile.WindowClientBounds.Y < 480)
            {
                profile.WindowClientBounds = new Point(profile.WindowClientBounds.X, 480);
            }
        }

        public static void UnLoadProfile()
        {
            GlobalProfile = null;
            CurrentProfile = null;
        }

        internal static void Save(Profile profile, string path, string filename = "profile.json")
        {
            ConfigurationResolver.Save(profile, Path.Combine(path, filename), ProfileJsonContext.DefaultToUse.Profile);
            if (GlobalProfile != null)
            {
                ConfigurationResolver.Save(GlobalProfile, Path.Combine(RootPath, "globalprofile.json"), ProfileJsonContext.DefaultToUse.GlobalProfile);
            }
        }
    }
}
